// Entry point: the installer while there is no database, then the database's schema brought up to date and the server
import { applyBootstrap } from './config/bootstrap.js';
import { migrate, runInstaller } from './installer.js';

if (!applyBootstrap()) await runInstaller(Number(process.env.API_PORT ?? 3000));
else await migrate(process.env.DATABASE_URL!);
await import('./server.js');
