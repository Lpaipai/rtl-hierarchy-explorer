// 2026/10/16 16:47:15 by liaoweipeng1
import { parentPort, workerData } from 'node:worker_threads';
import { RtlParser } from './parser';
import { ProjectIndexer } from './project';
import { ProjectChanges, ProjectConfig } from './model';
import { SlangProject } from './elaboration';

async function main(): Promise<void> {
  const parser = await RtlParser.create(workerData.assetDirectory);
  const projects = new Map<string, ProjectIndexer>();
  const elaborators = new Map<string, SlangProject>();
  let queue = Promise.resolve();
  parentPort!.on('message', (request: {
    id: number; configs: ProjectConfig[]; overlays: Record<string, string>; force: boolean;
    changes: Record<string, ProjectChanges>;
    dirtyFiles?: string[];
  }) => {
    queue = queue.then(async () => {
      try {
        const roots = new Set(request.configs.map(config => config.root));
        for (const root of projects.keys()) { if (!roots.has(root)) { projects.delete(root); } }
        for (const root of elaborators.keys()) { if (!roots.has(root)) { elaborators.delete(root); } }
        const snapshots = [];
        for (const config of request.configs) {
          if (config.analysisMode === 'elaborated') {
            projects.delete(config.root);
            let elaborator = elaborators.get(config.root);
            if (!elaborator) {
              elaborator = new SlangProject(workerData.assetDirectory, (pid, running) => {
                parentPort!.postMessage({ childPid: pid, running });
              });
              elaborators.set(config.root, elaborator);
            }
            snapshots.push(await elaborator.update(config, request.dirtyFiles, request.force,
              request.changes[config.root] ?? { changedFiles: [], rediscover: false }));
            continue;
          }
          elaborators.delete(config.root);
          let project = projects.get(config.root);
          if (!project) { project = new ProjectIndexer(parser); projects.set(config.root, project); }
          snapshots.push(await project.update(config, request.overlays, request.force,
            request.changes[config.root] ?? { changedFiles: [], rediscover: false }));
        }
        parentPort!.postMessage({ id: request.id, snapshots });
      } catch (error) { parentPort!.postMessage({ id: request.id, error: String(error) }); }
    });
  });
}

main().catch(error => { throw error; });
