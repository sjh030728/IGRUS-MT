import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * ★host: true 가 여기서 제일 중요한 줄이다★
 * CLAUDE.md: "사회자 노트북 로컬 실행 + 공유기 LAN. QR은 로컬 IP를 담는다."
 * 기본값(localhost)이면 폰이 못 붙는다 — 당일 7:55에 알게 되는 종류의 실수다.
 */
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 5173 },
});
