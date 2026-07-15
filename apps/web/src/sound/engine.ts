import { serverNow } from '../socket.js';

/**
 * ═══ 사운드 엔진 ═══ CLAUDE.md: "사운드 (필수, 부가기능 아님)"
 *
 * ★음원 파일이 없다. 전부 합성이다★
 * 클라우드 배포 금지 = 오프라인 LAN 전제라 음원을 받아올 데가 없다. 그런데 단계 1이
 * 요구하는 셋(틱/긴장 BGM/리빌 스팅)은 합성이 오히려 맞다 — 틱이 phaseEndsAt에
 * 샘플 단위로 박히고, BGM 템포를 남은 시간에서 파생시킬 수 있다.
 * 사운드보드(SfxCue 5종)는 진짜 음원이 나은데 그건 단계 4다.
 *
 * ★모든 스케줄이 phaseEndsAt 기준이다. "지금 울려라" 이벤트가 없다★
 * display.ts: "틱을 3발 쏘면 LAN 지터 때문에 소리와 화면이 어긋난다. endsAt을 주고
 * 빔이 로컬에서 스케줄하면 '0'이 정확히 그 프레임에 떨어진다."
 * 그래서 서버 지연이 얼마든 0은 정시에 떨어진다. 재접속도 남은 것만 다시 잡으면 끝난다.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 예약해둔 소리. phase가 틀어지면 취소해야 해서 들고 있는다. */
  private pending: { bed: OscillatorNode[]; cd: OscillatorNode[] } = { bed: [], cd: [] };
  /** 같은 phase에 스냅샷이 두 번 오면 틱이 두 벌 잡힌다. 키로 막는다. */
  private scheduledKey = '';

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * ★7:58에 반드시 문제가 된다★ (events.ts health.displayAudioUnlocked)
   * 브라우저는 사용자 제스처 없이 소리를 안 낸다. 빔은 아무도 안 만지는 화면이라
   * 이걸 잊으면 무음으로 프로그램이 시작되고, 그게 성공 기준 위반이다.
   *
   * ★resume()을 그냥 await하면 안 된다 — 단계 1에서 실제로 당했다★
   * 오토플레이 정책이 막으면 resume()의 프로미스는 reject가 아니라 ★영원히 pending★이다.
   * 그대로 기다리면 이 함수가 절대 안 끝나고, 호출부의 setAudioReady도 안 불리고,
   * 빔이 관문 화면에 영구히 갇힌다. 소리가 안 나는 것보다 나쁘다 — 화면이 아예 안 넘어간다.
   * 그래서 경주를 붙이고 ★프로미스가 아니라 ctx.state를 믿는다★.
   */
  async unlock(): Promise<boolean> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    }

    await Promise.race([
      this.ctx.resume(),
      new Promise((r) => setTimeout(r, 600)),
    ]);

    // 무음 버퍼 한 방. iOS 사파리는 resume()만으론 안 열리고 실제 재생이 있어야 한다.
    // 빔이 노트북 크롬이라 지금은 불필요하지만, 폰으로 빔을 대신하는 날이 오면 이게 산다.
    if (this.ctx.state === 'running') {
      const buf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(0);
    }

    return this.unlocked;
  }

  /** 서버 시각 → AudioContext 시각. 이 한 줄이 소리와 화면을 묶는다. */
  private at(serverMs: number): number {
    const ctx = this.ctx!;
    return ctx.currentTime + (serverMs - serverNow()) / 1000;
  }

  /**
   * ★bucket이 있는 이유 — 예약한 소리는 취소할 수 있어야 한다★
   * 스케줄은 미래에 박히는데 현장은 계획대로 안 간다. 사회자가 4초에 조기 컷하면
   * 남은 6초치 맥박이 잠금 위로 계속 울린다. 예약해두고 못 끄면 그게 버그다.
   */
  private ping(at: number, freq: number, dur: number, gain: number, type: OscillatorType = 'square', bucket?: 'bed' | 'cd') {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // 딸깍 소리가 나지 않게 짧은 페이드. 그냥 끊으면 클릭 노이즈가 낀다.
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    if (bucket) this.pending[bucket].push(osc);
  }

  /** 아직 안 울린 예약을 죽인다. 이미 울리기 시작한 건 그대로 둔다. */
  private killBucket(b: 'bed' | 'cd'): void {
    const now = this.ctx!.currentTime;
    for (const o of this.pending[b]) {
      try { o.stop(now); } catch { /* 이미 끝난 노드 */ }
    }
    this.pending[b] = [];
  }

  /**
   * ★카운트다운. 두구두구의 "3-2-1-0"★
   * 남은 초마다 틱을 잡고, endsAt에 정확히 리빌 스팅을 얹는다.
   * ★이미 지난 틱은 안 잡는다★ — 재접속하면 남은 것만 잡히고 과거가 한꺼번에 안 터진다.
   */
  countdown(key: string, endsAt: number): void {
    if (!this.ctx || this.scheduledKey === key) return;
    this.scheduledKey = key;

    const n = Math.ceil((endsAt - serverNow()) / 1000);
    for (let i = n; i >= 1; i--) {
      const t = endsAt - i * 1000;
      if (t <= serverNow() + 20) continue; // 지났으면 건너뛴다
      // 마지막 틱이 제일 높고 크다. 긴장이 올라간다.
      this.ping(this.at(t), i === 1 ? 1200 : 800, 0.09, i === 1 ? 0.5 : 0.32, 'square', 'cd');
    }
    if (endsAt > serverNow()) this.revealAt(endsAt); // ★0에 착지★
  }

  /** 동시 공개. 화음 한 방 — 세 음을 같이 때린다. C 메이저: 긴장(A단조)의 나란한조다. */
  private revealAt(serverMs: number): void {
    const at = this.at(serverMs);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.ping(at, f, 0.9 - i * 0.1, 0.3, 'triangle', 'cd'));
    // 밑에 깔리는 저음이 "쿵"을 만든다.
    this.ping(at, 65, 0.7, 0.5, 'sine', 'cd');
  }

  /**
   * 잠금. phase.ts: "잠금 스팅 직후 '마감! (아우성) ...자, 갑니다'가 오디오다."
   *
   * ★문이 닫히는 소리지 에러가 아니다★
   * 처음엔 톱니파로 220Hz → 155Hz를 때렸는데, 그 비가 1.419라 ★하강 트라이톤★이었다
   * (√2 = 1.414). 트라이톤 + 톱니파 = 사이렌/경고음의 공식이라 "너 틀렸어"로 들렸다.
   * 잠금은 나쁜 일이 아니다 — 아무도 안 졌고 그냥 마감된 거다. 드라마는 다음 구간
   * (두구두구)이 맡는다. 여기선 깔끔한 구두점만 찍는다.
   *
   * 그래서 음정을 아예 없앴다. 피치가 빠르게 떨어지는 사인 = 킥 드럼이고,
   * 킥은 화음이 아니라 ★타점★이라 어떤 음악과도 안 부딪히고 감정색도 없다.
   */
  lockSting(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const at = this.at(serverNow());

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    // 180 → 55Hz. 이 하강이 "쿵"의 정체다. 귀는 음정이 아니라 충격으로 듣는다.
    osc.frequency.setValueAtTime(180, at);
    osc.frequency.exponentialRampToValueAtTime(55, at + 0.11);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.5, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.3);

    // 짧고 높은 클릭 = "철컥". 자음이 있어야 닫힌 게 들린다.
    this.ping(at, 1500, 0.025, 0.1, 'triangle');
  }

  /** 점수 확정. 짧고 밝게 — 여기서 점수판이 움직인다. */
  scoreSting(): void {
    if (!this.ctx) return;
    const at = this.at(serverNow());
    [659.25, 880, 1318.5].forEach((f, i) => this.ping(at + i * 0.06, f, 0.25, 0.28, 'triangle'));
  }

  /**
   * ★긴장 BGM. CLAUDE.md가 지목한 사망 구간을 덮는 것★
   * "오디오가 죽는 구간은 게임 사이가 아니라 입력 대기 10초다."
   *
   * ★드론을 뺐다 — 그게 "기분 나쁨"의 정체였다★
   * 원래 55Hz 톱니 드론을 10초 내내 깔았다. 지속되는 저음 드론은 공포영화 문법이고,
   * 10초 동안 끊기지 않으니 도망갈 데가 없다. 그런데 ★이 구간은 무서운 구간이 아니다★ —
   * "빨리 눌러!"지 "너 죽는다"가 아니다. 맥박은 재촉하고 드론은 위협한다.
   * 그래서 리듬만 남겼다. 사망 구간을 덮는 건 밀도지 불쾌함이 아니다.
   *
   * 임박할수록 빨라지고 높아진다. 남은 시간에서 파생하므로 별도 이벤트가 없고,
   * 재접속하면 지금 남은 만큼으로 다시 잡힌다.
   */
  bedOn(key: string, endsAt: number): void {
    if (!this.ctx || this.scheduledKey === key) return;
    this.scheduledKey = key;
    this.killBucket('bed');

    let t = serverNow() + 80;
    let guard = 0;
    while (t < endsAt && guard++ < 200) {
      const remain = endsAt - t;
      // A단조 3화음을 타고 오른다 (A4 → C5 → E5). 리빌의 C장조와 나란한조라 안 부딪힌다.
      const pitch = remain > 5000 ? 440 : remain > 2000 ? 523.25 : 659.25;
      this.ping(this.at(t), pitch, 0.055, 0.15, 'triangle', 'bed');
      // 짧은 몸통. 드론 없이 무게를 준다 — 깔리는 게 아니라 때리고 빠진다.
      this.ping(this.at(t), 110, 0.05, 0.11, 'sine', 'bed');
      t += clamp(remain / 8, 140, 620);
    }
  }

  bedOff(): void {
    if (this.ctx) this.killBucket('bed');
  }

  /**
   * ★무효 처리. 예약된 걸 전부 취소한다★
   * COUNTDOWN → ABORTED 는 합법 전이다(phase.ts). 취소 안 하면 무효 처리했는데도
   * 3초 뒤에 리빌 화음이 터진다 — 사회자가 "이 문제 무효!"라고 말한 위로.
   */
  abortPending(): void {
    if (!this.ctx) return;
    this.killBucket('bed');
    this.killBucket('cd');
  }

  /** phase가 바뀌면 예약을 무효화한다. 다음 phase가 자기 걸 새로 잡는다. */
  resetSchedule(): void {
    this.scheduledKey = '';
  }
}

export const sound = new SoundEngine();
