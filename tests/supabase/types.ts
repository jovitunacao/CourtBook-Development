export type TestStatus = 'PASS' | 'FAIL' | 'BLOCKED';
export type TestOperationType = 'READ_ONLY' | 'STATE_CHANGING';

export interface TestResult {
  id: string;
  category: string;
  name: string;
  status: TestStatus;
  operationType?: TestOperationType;
  durationMs: number;
  details?: string;
  error?: string;
  suggestedFix?: string;
}

export interface TestSuite {
  name: string;
  category: string;
  run: () => Promise<TestResult[]>;
}

export interface TestReportSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  readOnlyCount: number;
  stateChangingCount: number;
  durationMs: number;
  results: TestResult[];
}
