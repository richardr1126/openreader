import { spawnSync } from 'node:child_process';

export function hasNatsBinary() {
  return !spawnSync('nats-server', ['-v'], { stdio: 'ignore' }).error;
}
