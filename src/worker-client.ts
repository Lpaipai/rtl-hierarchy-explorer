// 2026/10/16 17:13:42 by liaoweipeng1
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ProjectChanges, ProjectConfig, ProjectSnapshot } from './model';

export class ParserWorker {
  private readonly worker: Worker;
  private sequence = 0;
  private failure?: Error;
  private readonly children = new Set<number>();
  private readonly pending = new Map<number, {
    resolve: (snapshots: ProjectSnapshot[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(assetDirectory: string, private readonly timeoutMs = 120_000) {
    this.worker = new Worker(path.join(assetDirectory, 'worker.cjs'), { workerData: { assetDirectory } });
    this.worker.on('message', (message: { id: number; snapshots: ProjectSnapshot[]; error?: string; childPid?: number; running?: boolean }) => {
      if (message.childPid) {
        if (message.running && this.failure) {
          try { process.kill(message.childPid, 'SIGKILL'); } catch { /* Already exited. */ }
        } else if (message.running) { this.children.add(message.childPid); }
        else { this.children.delete(message.childPid); }
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) { return; }
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) { request.reject(new Error(message.error)); }
      else { request.resolve(message.snapshots); }
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => this.fail(new Error(`解析工作线程已退出 (${code})，请刷新重试。`)));
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pid of this.children) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The child may have already exited. */ }
    }
    this.children.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  update(configs: ProjectConfig[], overlays: Record<string, string>, force: boolean,
    changes: Record<string, ProjectChanges> = {}, dirtyFiles: string[] = []): Promise<ProjectSnapshot[]> {
    if (this.failure) { return Promise.reject(this.failure); }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.fail(new Error(`索引超过 ${this.timeoutMs / 1000} 秒，已终止工作线程；请缩小范围后刷新重试。`));
        void this.worker.terminate();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, configs, overlays, force, changes, dirtyFiles }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  dispose(): void {
    this.fail(new Error('解析器已关闭'));
    void this.worker.terminate();
  }
}
