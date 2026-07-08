const repoGenerations = new Map<string, number>();

export function getRepoCacheGeneration(root: string): number {
  return repoGenerations.get(root) ?? 0;
}

export function invalidateRepoCaches(root: string): void {
  repoGenerations.set(root, getRepoCacheGeneration(root) + 1);
}
