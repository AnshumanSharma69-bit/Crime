import { createApp } from './app';
import { makePool } from './db';
const port = Number(process.env.PORT ?? 4000);
createApp(makePool()).listen(port, () => console.log(`CrimeLens API listening on :${port}`));
