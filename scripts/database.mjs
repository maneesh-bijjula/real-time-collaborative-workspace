import { parseArgs } from 'node:util';
import { Compose, OperationError, event } from './lib/compose.mjs';
import { backup, restore } from './lib/backup.mjs';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      'env-file': { type: 'string' },
      file: { type: 'string', multiple: true },
      service: { type: 'string', default: 'postgres' },
      output: { type: 'string' },
      backup: { type: 'string' },
      database: { type: 'string' },
      'timeout-seconds': { type: 'string', default: '300' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'backup --project NAME --file COMPOSE [--file OVERRIDE] [--service postgres] [--database SOURCE_DB] [--env-file ENV_FILE] --output NEW_DIRECTORY\nrestore --project NAME --file COMPOSE [--service postgres] [--env-file ENV_FILE] --backup DIRECTORY --database NEW_DATABASE\nRequires Node 24, Docker Compose, a PostgreSQL 17 service with POSTGRES_USER/PASSWORD/DB; refuses overwrites. --timeout-seconds 30..3600.',
    );
  } else {
    const seconds = Number(values['timeout-seconds']);
    if (
      positionals.length !== 1 ||
      !['backup', 'restore'].includes(positionals[0]) ||
      !Number.isInteger(seconds) ||
      seconds < 30 ||
      seconds > 3600
    )
      throw new OperationError('invalid_arguments');
    const compose = new Compose(values.project, values.file, values['env-file']);
    if (positionals[0] === 'backup') {
      if (!values.output || values.backup)
        throw new OperationError('new_output_directory_required');
      await backup(compose, values.service, values.output, seconds, values.database);
    } else {
      if (!values.backup || values.output || !values.database)
        throw new OperationError('backup_and_new_database_required');
      await restore(compose, values.service, values.backup, values.database, seconds);
    }
  }
} catch (error) {
  event('database_operation_failed', {
    reason:
      error instanceof OperationError
        ? error.reason
        : error?.code === 'EEXIST'
          ? 'output_already_exists'
          : 'invalid_or_incomplete_backup_or_operation',
  });
  process.exitCode = 1;
}
