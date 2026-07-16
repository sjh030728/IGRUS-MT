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
  ResumeToken,
  TeamId,
  type EpochMs,
  type Me,
} from '@mt/protocol';
import { DbService } from '../core/db.service.js';
import { LedgerService } from '../core/ledger.service.js';
import { RoundService } from '../core/round.service.js';
import { projectDisplay, projectHost, projectPlay } from '../core/projector.js';

type Role = 'host' | 'play' | 'display';

/** 단계 1은 콘솔 토큰을 부팅 때 찍는다. 단계 4에서 QR/설정으로 옮긴다. */
const HOST_TOKEN = process.env['HOST_TOKEN'] ?? 'mt-host';

const now = (): EpochMs => Date.now();

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
  private displayAudioUnlocked = false;

  constructor(
    private readonly rounds: RoundService,
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

    // resumeToken이 있으면 신원 복구. 배터리 위험 대응의 절반이 이 한 줄이다.
    let pid = p.data.resumeToken ? this.tokens.get(p.data.resumeToken) : undefined;
    let token = p.data.resumeToken;

    if (!pid) {
      if (!this.rounds.state.entryOpen) return { ok: false as const, code: 'ENTRY_CLOSED', message: '입장이 마감됐어요' };
      pid = ParticipantId.parse(`p${randomBytes(4).toString('hex')}`);
      token = ResumeToken.parse(randomBytes(16).toString('hex'));
      this.tokens.set(token, pid);
    }

    const name = p.data.name ?? '익명';
    const teamId = p.data.teamId ?? this.rounds.state.teams[0]!.teamId;
    this.rounds.join(pid, name, teamId);
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
      default:
        // 나머지 명령(되감기/보정/낮PG/예비투입/Live/사람관리/SFX)은 단계 3~4다.
        // 계약엔 있고 구현이 없다 — 조용히 성공시키면 사회자가 눌렀는데 아무 일도 안 난다.
        return { ok: false as const, code: 'NOT_IMPLEMENTED', message: `${cmd.c}는 다음 단계` };
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
