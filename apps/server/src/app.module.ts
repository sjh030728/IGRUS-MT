import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { DbService } from './core/db.service.js';
import { LedgerService } from './core/ledger.service.js';
import { LiveService } from './core/live.service.js';
import { RoundService } from './core/round.service.js';
import { EventsGateway } from './gateway/events.gateway.js';

@Module({
  providers: [DbService, LedgerService, RoundService, LiveService, EventsGateway],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(private readonly rounds: RoundService) {}

  /** 프리플라이트(전 GAME 세그먼트 적재 시험) + 첫 세그먼트 진입. 실패하면 부팅이 죽는다 — 7:30 원칙. */
  async onApplicationBootstrap() {
    await this.rounds.start();
  }
}
