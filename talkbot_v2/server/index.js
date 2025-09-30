import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ttsRoute } from './routes/tts.js';
import { healthzRoute } from './routes/healthz.js';
import { corsMw } from './middleware/cors.js';
import { requestIdMw } from './middleware/requestId.js';
import { errorMw } from './middleware/errors.js';

const app = express();
app.disable('x-powered-by');

app.use(corsMw());
app.use(requestIdMw());

app.use('/api/tts', ttsRoute);
app.use('/healthz', healthzRoute);

// static
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/audio',  express.static(path.join(__dirname, '..', 'audio')));
app.use('/avatar', express.static(path.join(__dirname, '..', 'avatar')));

// errors last
app.use(errorMw());

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('[talkbot_v2] listening on', port));
