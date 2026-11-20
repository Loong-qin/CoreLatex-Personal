import { describe, it, expect } from 'vitest';
import { formatTokens } from './projectUtils.js';


describe('formatTokens（用量可视化 token 格式化）', () => {
  it('从一千起每三位使用英文逗号', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(9999)).toBe('9,999');
  });

  it('保留数值或数字字符串的完整 token 数', () => {
    expect(formatTokens(60_203_584)).toBe('60,203,584');
    expect(formatTokens('456000000')).toBe('456,000,000');
    expect(formatTokens(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
  });

  it('负值和空值显示为零', () => {
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(undefined)).toBe('0');
  });
});
