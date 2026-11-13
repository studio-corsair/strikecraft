import { describe, expect, it } from 'vitest';
import { sortQuarters, timingLabel } from '../src/screens/Earnings.tsx';
import { countBeyond, yearLabels } from '../src/components/MoveBars.tsx';

const q = (date: string, movePct: number | null, closeBefore: number | null = 100) => ({
  date,
  timing: 'AMC',
  closeBefore,
  closeAfter: 100,
  movePct,
  gapPct: 0,
});

describe('sortQuarters', () => {
  const rows = [q('2024-02-01', -3), q('2024-05-01', 12), q('2024-08-01', null), q('2024-11-01', 2)];
  it('sorts numeric columns numerically, empty last', () => {
    expect(sortQuarters(rows, 'movePct', 'asc').map((r) => r.movePct)).toEqual([-3, 2, 12, null]);
    expect(sortQuarters(rows, 'movePct', 'desc').map((r) => r.movePct)).toEqual([12, 2, -3, null]);
  });
  it('sorts dates newest first', () => {
    expect(sortQuarters(rows, 'date', 'desc')[0]!.date).toBe('2024-11-01');
  });
  it('does not mutate its input', () => {
    sortQuarters(rows, 'movePct', 'asc');
    expect(rows[0]!.date).toBe('2024-02-01');
  });
});

describe('chart helpers', () => {
  it('counts bars beyond the implied move', () => {
    expect(countBeyond([q('a', -9), q('b', 3), q('c', 7), q('d', null)], 6)).toBe(2);
    expect(countBeyond([q('a', 9)], null)).toBe(0);
  });
  it('thins year labels from the newest, dropping a lone early quarter', () => {
    const dates = ['2021-11-23', '2022-02-22', '2022-05-24', '2022-08-23', '2022-11-22', '2023-02-21'];
    expect(yearLabels(dates, (i) => i * 20, 50).map((y) => y.text)).toEqual(['2022', '2023']);
  });
  it('labels timing', () => {
    expect(timingLabel('BMO')).toBe('Before open');
    expect(timingLabel(null)).toBe('–');
  });
});
