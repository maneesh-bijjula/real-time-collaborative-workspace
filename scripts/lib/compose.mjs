import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export class OperationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// Never attach child errors, command output, SQL, or configuration to exceptions.
export async function run(
  file,
  args,
  {
    input,
    stdout,
    timeout = 300000,
    env = process.env,
    inherit = false,
    signal,
    failOnStderr = false,
  } = {},
) {
  const child = spawn(file, args, {
    cwd: root,
    env,
    signal,
    stdio: inherit ? 'inherit' : ['pipe', stdout ?? 'pipe', 'pipe'],
  });
  let output = '',
    tooLarge = false,
    warned = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', () => reject(new OperationError('command_unavailable')));
    child.once('close', (code) =>
      code === 0 && !tooLarge && !warned
        ? resolveExit()
        : reject(
            new OperationError(
              code !== 0 || tooLarge ? 'command_failed' : 'command_reported_warning',
            ),
          ),
    );
  });
  // Install a rejection handler immediately while stream setup is in progress.
  exited.catch(() => {});
  child.stderr?.on('data', () => {
    if (failOnStderr) warned = true;
  });
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
      tooLarge = true;
      child.kill('SIGKILL');
    }
  });
  try {
    if (!inherit) {
      if (input && typeof input !== 'string' && !Buffer.isBuffer(input))
        await Promise.all([exited, pipeline(input, child.stdin)]);
      else {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        await exited;
      }
    } else await exited;
    return output.trim();
  } catch (error) {
    child.kill('SIGKILL');
    throw error instanceof OperationError ? error : new OperationError('command_failed');
  } finally {
    clearTimeout(timer);
  }
}

export class Compose {
  constructor(project, files, envFile) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? '') || !files?.length)
      throw new OperationError('explicit_project_and_compose_files_required');
    this.project = project;
    this.args = [
      'compose',
      '-p',
      project,
      ...(envFile ? ['--env-file', resolve(root, envFile)] : []),
      ...files.flatMap((file) => ['-f', resolve(root, file)]),
    ];
  }
  run(args, options) {
    return run('docker', [...this.args, ...args], options);
  }
  pgArgs(service, tool, args = [], timeoutSeconds = 300) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(service) ||
      !['psql', 'pg_dump', 'pg_restore', 'createdb'].includes(tool)
    )
      throw new OperationError('invalid_postgres_service_or_tool');
    return [
      'exec',
      '-T',
      '-e',
      'PGCONNECT_TIMEOUT=5',
      '-e',
      `PGOPTIONS=-c statement_timeout=${timeoutSeconds * 1000} -c lock_timeout=5000`,
      service,
      'sh',
      '-ceu',
      args.length === 1 && args[0] === '--version'
        ? `exec ${tool} "$@"`
        : `export PGPASSWORD="$POSTGRES_PASSWORD"; exec ${tool} --username="$POSTGRES_USER" "$@"`,
      '_',
      ...args,
    ];
  }
  pg(service, tool, args, options = {}) {
    return this.run(this.pgArgs(service, tool, args, options.timeoutSeconds), {
      ...options,
      timeout: (options.timeoutSeconds ?? 300) * 1000,
    });
  }
  sql(service, database, sql, options) {
    return this.pg(
      service,
      'psql',
      ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql],
      options,
    );
  }
  async assertPostgres(service) {
    const config = JSON.parse(await this.run(['config', '--format', 'json']));
    const selected = config.services?.[service];
    if (!selected?.environment?.POSTGRES_USER || !selected?.environment?.POSTGRES_DB)
      throw new OperationError('postgres_service_configuration_required');
  }
}

export function event(name, fields = {}) {
  console.log(JSON.stringify({ event: name, ...fields }));
}
