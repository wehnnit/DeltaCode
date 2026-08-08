export function isGitUrl(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ||
    target.endsWith(".git") ||
    target.startsWith("git@") ||
    /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+[/:]/.test(target)
  );
}
