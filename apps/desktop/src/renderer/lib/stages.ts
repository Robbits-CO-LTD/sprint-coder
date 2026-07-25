import type { TurnStage } from '../types/sprint-coder';

// Turn stage vocabulary. Extracted from store/appStore.ts (issue #16) to break a cycle: the progress
// arithmetic needs the order, and the store needs the arithmetic, so neither can own it. This module
// depends on nothing but the type, which makes it a safe base for both.
//
// This is also the documented source of truth for §4.3's five stages — the design doc points here.

export const STAGE_LABEL: Record<TurnStage, string> = {
  understanding: 'ユーザーの依頼を理解中',
  planning: '方針を組み立て中',
  executing: 'ファイル・コマンドを実行中',
  synthesizing: '回答をまとめ中',
  waiting_approval: '承認を待っています',
};

export const STAGE_ORDER: TurnStage[] = [
  'understanding',
  'planning',
  'executing',
  'waiting_approval',
  'synthesizing',
];
