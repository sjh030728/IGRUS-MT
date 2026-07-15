import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { LedgerService } from './core/ledger.service.js';
import { RoundService } from './core/round.service.js';
import { EventsGateway } from './gateway/events.gateway.js';

@Module({
  providers: [LedgerService, RoundService, EventsGateway],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(private readonly rounds: RoundService) {}

  /** 단계 1은 더미 라운드 1개를 부팅 때 적재한다. 단계 2에서 세그먼트 러너가 맡는다. */
  async onApplicationBootstrap() {
    await this.rounds.loadDummyRound();
  }
}
