import { isSafeNumber, LosslessNumber, parse, stringify } from 'lossless-json';

// Python clients send int64 IDs as JSON numbers; native JSON.parse rounds them.
export function parseOneBotJson(text: string): unknown {
  return parse(text, (_key, value) => {
    if (value && typeof value === 'object' && !(value instanceof LosslessNumber)) {
      if ((!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) ||
          Object.hasOwn(value, 'isLosslessNumber')) {
        throw new SyntaxError('Invalid JSON object prototype or reserved number marker');
      }
      const constructor = (value as Record<string, unknown>).constructor;
      if (Object.hasOwn(value, 'constructor') && constructor && typeof constructor === 'object' &&
          Object.hasOwn(constructor, 'prototype')) {
        throw new SyntaxError('Invalid JSON constructor prototype');
      }
    }
    return value;
  }, value => {
    const number = Number(value);
    return isSafeNumber(value) && (!Number.isInteger(number) || Number.isSafeInteger(number))
      ? number : new LosslessNumber(value);
  });
}

export function stringifyOneBotJson(value: unknown): string {
  return stringify(value) ?? 'null';
}
