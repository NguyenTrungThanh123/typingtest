let transition = false;

export function set(val: boolean): void {
  transition = val;
}

export function get(): boolean {
  return transition;
}
