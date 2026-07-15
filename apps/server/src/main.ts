import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

/**
 * ★0.0.0.0으로 바인딩하는 게 중요하다★
 * CLAUDE.md: "사회자 노트북 로컬 실행 + 공유기 LAN. QR은 로컬 IP를 담는다."
 * localhost로 바인딩하면 폰이 못 붙는다 — 당일 7:55에 알게 되는 종류의 실수다.
 */
const PORT = Number(process.env['PORT'] ?? 3000);

const app = await NestFactory.create(AppModule);
app.enableCors({ origin: true });
await app.listen(PORT, '0.0.0.0');
console.log(`[server] listening on 0.0.0.0:${PORT}`);
