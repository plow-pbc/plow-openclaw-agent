export function toolFactory(value: any): any {
  const create = typeof value === "function" ? value : value.create;
  return (context: any) => create({ ...context, assertInvocationCurrent: context.assertInvocationCurrent ?? (() => {}) });
}
