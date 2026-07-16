import { randomBytes } from 'node:crypto';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  HostCmd,
  ParticipantId,
  PlayHello,
  PlaySubmit,
  PlayTap,
  ResumeToken,
  TeamId,
  type EpochMs,
  type Me,
} from '@mt/protocol';
import { DbService } from '../core/db.service.js';
import { LedgerService } from '../core/ledger.service.js';
import { LiveService } from '../core/live.service.js';
import { RoundService } from '../core/round.service.js';
import { loadSessionConfig } from '../core/config.js';
import { projectDisplay, projectHost, projectPlay } from '../core/projector.js';

type Role = 'host' | 'play' | 'display';

/** env가 이기고, 그다음 config(7:30에 고치는 파일), 마지막이 개발 기본값. */
const HOST_TOKEN = process.env['HOST_TOKEN'] ?? loadSessionConfig().hostToken ?? 'mt-host';

const now = (): EpochMs => Date.now();

/** 입장 코드 문자셋 — 0/O/1/I 없음. 소리로 불러줄 값이라 헷갈리는 글자를 뺀다. */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const mintCode = (): string =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

/**
 * ═══ WS 표면 ═══
 *
 * ★이 파일이 게임 전체의 무결성이다★ (events.ts 헤더)
 * "소켓의 room 소속으로 판정하면 안 된다 — 클라이언트가 join을 스스로 부를 수 있다.
 *  서버가 핸드셰이크 때 소켓에 역할을 붙이고, 미들웨어가 이벤트 이름 앞부분과 대조한다."
 * 폰이 host 이벤트를 쏠 수 있으면 그 순간 끝이다.
 */
@WebSocketGateway({ cors: { origin: true } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  private readonly tokens = new Map<ResumeToken, ParticipantId>();
  /** 입장 코드 → pid. REISSUE_TOKEN이 채우고 claim이 소비한다. 1회용. */
  private readonly claims = new Map<string, ParticipantId>();
  private displayAudioUnlocked = false;

  constructor(
    private readonly rounds: RoundService,
    private readonly live: LiveService,
    private readonly ledger: LedgerService,
    private readonly db: DbService,
  ) {}

  afterInit(server: Server) {
    /**
     * ★핸드셰이크에서 역할을 박는다. 이후 누구도 못 바꾼다★
     * 클라가 auth.role을 자칭하지만, host만은 토큰을 검사한다 —
     * 나머지 둘(play/display)은 권한이 없어서 자칭해도 얻는 게 없다.
     */
    server.use((socket, next) => {
      const claimed = socket.handshake.auth?.['role'];
      if (claimed === 'host') {
        if (socket.handshake.auth?.['token'] !== HOST_TOKEN) return next(new Error('BAD_HOST_TOKEN'));
        socket.data.role = 'host';
      } else if (claimed === 'display') {
        socket.data.role = 'display';
      } else {
        socket.data.role = 'play';
      }
      next();
    });

    // 이벤트 이름 앞부분 = 인증 규칙. 검사가 여기 한 곳에만 있다.
    server.use((socket, next) => {
      socket.use(([event], allow) => {
        const prefix = String(event).split(':')[0];
        if (prefix !== 'time' && prefix !== socket.data.role) {
          return allow(new Error(`FORBIDDEN: ${socket.data.role} cannot emit ${event}`));
        }
        allow();
      });
      next();
    });

    // 상태가 바뀌면 역할별 스냅샷을 통째로 다시 쏜다. 델타 병합도 리플레이도 없다.
    this.rounds.changes$.subscribe(() => this.broadcast());
    // DB 미러가 죽거나 살아나면 콘솔 health가 그 즉시 바뀌어야 한다 — 사회자의 계기판이다.
    this.db.status$.subscribe(() => this.pushHost());

    // ★스냅샷 우회 채널 2개★ (events.ts) — 빈도가 스냅샷을 태울 수 없는 것만.
    // volatile: 늦은 프레임은 재전송이 아니라 폐기다 — 0.05초 전 바 위치는 쓰레기다.
    this.live.frames$.subscribe((f) => this.server.to('display').volatile.emit('live:frame', f));
    // 의심 목록은 ★host room에만★ (anticheat.ts — 빔에 오탐이 뜨면 그 밤이 끝난다).
    this.live.hostTicks$.subscribe((t) => this.server.to('host').emit('live:hostTick', t));
  }

  async handleConnection(socket: Socket) {
    const role = socket.data.role as Role;
    await socket.join(role);
    if (role === 'display') this.pushDisplay();
    if (role === 'host') this.pushHost();
  }

  handleDisconnect(socket: Socket) {
    const pid = socket.data.participantId as ParticipantId | undefined;
    if (pid) this.rounds.setConnected(pid, false);
  }

  // ── 폰 ────────────────────────────────────────────────────

  @SubscribeMessage('play:hello')
  playHello(socket: Socket, payload: unknown) {
    const p = PlayHello.safeParse(payload);
    if (!p.success) return { ok: false as const, code: 'INVALID', message: '잘못된 요청' };

    let pid: ParticipantId | undefined;
    let token: ResumeToken | undefined;

    // ★입장 코드가 최우선★ — 빌린 폰의 localStorage엔 주인의 토큰이 있어서(events.ts PlayHello)
    // resumeToken보다 먼저 봐야 한다. 코드는 1회용, 옛 토큰은 전부 무효화(분실 폰 = 분실 열쇠).
    const claim = p.data.claim?.toUpperCase();
    if (claim && this.claims.has(claim)) {
      pid = this.claims.get(claim)!;
      this.claims.delete(claim);
      for (const [t, owner] of this.tokens) if (owner === pid) this.tokens.delete(t);
      token = ResumeToken.parse(randomBytes(16).toString('hex'));
      this.tokens.set(token, pid);
      // 같은 신원의 산 소켓이 있으면 밀어낸다 — 한 사람 = 한 폰 (sys:bye 계약).
      for (const [, s] of this.server.sockets.sockets) {
        if (s.data.participantId === pid && s.id !== socket.id) {
          s.emit('sys:bye', { reason: '다른 폰에서 입장 코드로 들어왔어요' });
          s.data.participantId = undefined;
        }
      }
    } else if (claim) {
      return { ok: false as const, code: 'BAD_CODE', message: '코드가 틀렸거나 이미 쓰였어요' };
    }

    // resumeToken이 있으면 신원 복구. 배터리 위험 대응의 절반이 이 한 줄이다.
    if (!pid) {
      pid = p.data.resumeToken ? this.tokens.get(p.data.resumeToken) : undefined;
      token = pid ? p.data.resumeToken : undefined;
    }

    if (!pid) {
      if (!this.rounds.state.entryOpen) return { ok: false as const, code: 'ENTRY_CLOSED', message: '입장이 마감됐어요' };
      pid = ParticipantId.parse(`p${randomBytes(4).toString('hex')}`);
      token = ResumeToken.parse(randomBytes(16).toString('hex'));
      this.tokens.set(token, pid);
    }

    const name = p.data.name ?? '익명';
    // ★teamId를 안 보냈으면 null — join이 기존 배정을 유지한다★ 재접속 = 조 리셋이던 버그.
    this.rounds.join(pid, name, p.data.teamId ?? null);
    socket.data.participantId = pid;

    return {
      ok: true as const,
      participantId: pid,
      resumeToken: token!,
      state: projectPlay(this.rounds.state, this.meOf(pid)!, pid),
    };
  }

  @SubscribeMessage('play:submit')
  playSubmit(socket: Socket, payload: unknown) {
    const pid = socket.data.participantId as ParticipantId | undefined;
    if (!pid) return { ok: false as const, reason: 'NOT_IN_ROSTER' as const, message: '입장 정보가 없어요' };

    const p = PlaySubmit.safeParse(payload);
    if (!p.success) return { ok: false as const, reason: 'INVALID' as const, message: '잘못된 제출' };

    return this.rounds.submit(pid, p.data.roundId, p.data.value);
  }

  /**
   * 탭 배치. ★ack가 없다★ (events.ts C2S — 10Hz에 왕복을 달면 왕복이 2배가 된다)
   * 검증 실패·비적격·상한 초과 전부 조용히 버린다 — 처리는 엔진(live.service)이 한다.
   */
  @SubscribeMessage('play:tap')
  playTap(socket: Socket, payload: unknown) {
    const pid = socket.data.participantId as ParticipantId | undefined;
    if (!pid) return;
    const p = PlayTap.safeParse(payload);
    if (!p.success) return; // n=999999 같은 조작은 스키마가 여기서 끊는다 (verify §2)
    this.live.tap(pid, socket.id, p.data.matchId, p.data.n, p.data.windowMs);
  }

  // ── 빔 ────────────────────────────────────────────────────

  @SubscribeMessage('display:hello')
  displayHello() {
    return { state: this.displaySnapshot() };
  }

  /** 오토플레이 해제 여부 보고. 7:58에 반드시 문제가 된다. */
  @SubscribeMessage('display:status')
  displayStatus(_socket: Socket, payload: { audioUnlocked?: boolean }) {
    this.displayAudioUnlocked = Boolean(payload?.audioUnlocked);
    this.pushHost();
  }

  // ── 콘솔 ──────────────────────────────────────────────────

  @SubscribeMessage('host:hello')
  hostHello() {
    return { ok: true, state: this.hostSnapshot() };
  }

  /**
   * ★사회자 명령 전부가 이 한 구멍으로 들어온다★ (events.ts HostCmd)
   * "인증 검사 1곳, 감사 로그 1줄, phase 합법성 검증 1곳."
   */
  @SubscribeMessage('host:cmd')
  async hostCmd(_socket: Socket, payload: unknown) {
    const p = HostCmd.safeParse(payload);
    if (!p.success) return { ok: false as const, code: 'INVALID', message: '알 수 없는 명령' };
    const cmd = p.data;

    const reject = (m: string) => ({ ok: false as const, code: 'ILLEGAL', message: m });
    const done = { ok: true as const };

    switch (cmd.c) {
      case 'ROUND_PRESENT': return this.rounds.present() ? done : reject('지금 못 누름');
      case 'ROUND_OPEN': return this.rounds.open() ? done : reject('지금 못 누름');
      case 'ROUND_LOCK': return this.rounds.lock() ? done : reject('지금 못 누름');
      case 'ROUND_COUNTDOWN': return this.rounds.countdown() ? done : reject('지금 못 누름');
      case 'ROUND_SCORE': return this.rounds.commitScore() ? done : reject('REVEAL에서만 커밋');
      case 'ROUND_ABORT': return this.rounds.abort() ? done : reject('지금 못 누름');
      case 'ROUND_NEXT': return this.rounds.next() ? done : reject('커밋(REACTION) 뒤에만');
      case 'ROUND_GOTO': {
        const r = this.rounds.gotoRound(cmd.roundId);
        return r.ok ? done : reject(r.message);
      }
      case 'SEGMENT_GOTO': {
        const r = await this.rounds.gotoSegment(cmd.segmentId);
        return r.ok ? done : reject(r.message);
      }
      case 'SET_MULTIPLIER': return this.rounds.setMultiplier(cmd.m) ? done : reject('지금 못 바꿈');
      case 'SET_POINTS': return this.rounds.setPoints(cmd.basePoints) ? done : reject('IDLE..COLLECT 에서만');
      case 'DISPLAY_BLACKOUT': this.rounds.setBlackout(cmd.on); return done;
      case 'CLOSE_ENTRY': this.rounds.closeEntry(); return done;

      // ── Live (단계 3) — 상태머신·멱등은 전부 엔진 소유. 여기는 라우팅뿐이다 ──
      case 'LIVE_ARM': { const r = this.live.arm(cmd.spec); return r.ok ? done : reject(r.message); }
      case 'LIVE_START': { const r = this.live.start(cmd.matchId); return r.ok ? done : reject(r.message); }
      case 'LIVE_ABORT': { const r = this.live.abort(cmd.matchId); return r.ok ? done : reject(r.message); }
      case 'LIVE_COMMIT': { const r = this.live.commit(cmd.matchId); return r.ok ? done : reject(r.message); }

      // ── 점수 도구 (단계 4) — 전부 원장 기입. 검증은 원장이 한다 (되감기 규칙 포함) ──
      case 'SEED_SET': this.ledger.seedSet(cmd.totals, cmd.note); this.rounds.bump(); return done;
      case 'ADJUST': this.ledger.adjust(cmd.deltas, cmd.reason); this.rounds.bump(); return done;
      case 'VOID': {
        const r = this.ledger.voidSeq(cmd.seq, cmd.reason);
        if (r.ok) this.rounds.bump();
        return r.ok ? done : reject(r.message);
      }

      // ── 연출 — 사운드보드. ★display room에만★, 스냅샷 밖(일회성 푸시 — 재생할 상태가 아니다) ──
      case 'SFX':
        this.server.to('display').emit('sound:sfx', { cue: cmd.cue, at: now() });
        return done;

      // ── 사람 관리 ──
      case 'MUTE_PARTICIPANT':
        return this.rounds.setMuted(cmd.participantId, cmd.muted) ? done : reject('로스터에 없음');
      case 'ASSIGN_PARTICIPANT':
        return this.rounds.assign(cmd.participantId, cmd.teamId) ? done : reject('사람 또는 조가 없음');
      case 'REISSUE_TOKEN': {
        const person = this.rounds.state.roster.get(cmd.participantId);
        if (!person) return reject('로스터에 없음');
        // 이전 코드는 무효화 — 한 사람에 산 코드는 하나만.
        for (const [c, owner] of this.claims) if (owner === cmd.participantId) this.claims.delete(c);
        const code = mintCode();
        this.claims.set(code, cmd.participantId);
        // ★코드는 ack로만 나간다★ 스냅샷에 실으면 상태가 되고, 상태가 되면 지울 때를 정해야 한다.
        return { ok: true as const, note: `${person.name} 입장 코드: ${code} — 빌린 폰의 "코드 입장"에 입력` };
      }

      // ── 프로그램 — 예비 게임 즉시 투입 (CLAUDE.md 콘솔 필수기능 6/6 완성) ──
      case 'SEGMENT_INJECT': { const r = this.rounds.inject(cmd.gameId, cmd.after); return r.ok ? done : reject(r.message); }
    }
  }

  // ── 시계 ──────────────────────────────────────────────────

  /** 접속 시 1회. LAN이라 1~3ms면 충분하다. 카운트다운 정확도가 여기 걸려 있다. */
  @SubscribeMessage('time:ping')
  timePing(_socket: Socket, payload: { t0: number }) {
    return { t0: payload?.t0 ?? 0, t1: now() };
  }

  // ── 투영 + 브로드캐스트 ────────────────────────────────────

  private broadcast() {
    this.pushDisplay();
    this.pushHost();
    this.pushPlay();
  }

  private displaySnapshot() {
    const board = this.ledger.scoreboard(this.rounds.state.teams);
    return {
      state: projectDisplay(this.rounds.state, board),
      serverNow: now(),
      stateSeq: this.rounds.state.stateSeq,
    };
  }

  private hostSnapshot() {
    const s = this.rounds.state;
    const board = this.ledger.scoreboard(s.teams);
    return projectHost(s, board, this.ledger.totals(s.teams), this.ledger.tail(10), now(), {
      db: this.db.ok ? 'OK' : 'FAIL',
      displayConnected: (this.server.sockets.adapter.rooms.get('display')?.size ?? 0) > 0,
      displayAudioUnlocked: this.displayAudioUnlocked,
      phonesConnected: this.server.sockets.adapter.rooms.get('play')?.size ?? 0,
    });
  }

  private pushDisplay() { this.server.to('display').emit('state:display', this.displaySnapshot()); }
  private pushHost() { this.server.to('host').emit('state:host', this.hostSnapshot()); }

  /** ★폰은 스냅샷이 1인분씩 다르다★ me가 들어가므로 소켓별로 만든다. */
  private pushPlay() {
    for (const [, socket] of this.server.sockets.sockets) {
      if (socket.data.role !== 'play') continue;
      const pid = socket.data.participantId as ParticipantId | undefined;
      if (!pid) continue;
      const me = this.meOf(pid);
      if (me) socket.emit('state:play', projectPlay(this.rounds.state, me, pid));
    }
  }

  private meOf(pid: ParticipantId): Me | null {
    const s = this.rounds.state;
    const entry = s.roster.get(pid);
    if (!entry) return null;
    const team = s.teams.find((t) => t.teamId === entry.teamId) ?? s.teams[0]!;
    return {
      participantId: pid,
      teamId: team.teamId,
      name: entry.name,
      teamName: team.name,
      teamColor: team.color,
    };
  }
}
