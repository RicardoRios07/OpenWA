import { collectFilterErrors } from './filter-validation';
import { MESSAGE_TYPES } from './filter-types';

describe('collectFilterErrors (message-type enum)', () => {
  const typeCondition = (...types: string[]) => ({
    conditions: [{ field: 'type', operator: 'is', value: types }],
  });

  it('accepts every neutral message type, including poll', () => {
    // `poll` was offered by the dashboard's type picker while validation refused it, so a saved
    // filter could never round-trip. The list must cover the whole neutral union.
    expect(collectFilterErrors(typeCondition('poll'))).toEqual([]);
    expect(collectFilterErrors(typeCondition(...MESSAGE_TYPES))).toEqual([]);
  });

  it('still rejects a type outside the neutral union', () => {
    expect(collectFilterErrors(typeCondition('banana'))).toEqual(['conditions[0].value "banana" is not a valid type']);
  });
});
