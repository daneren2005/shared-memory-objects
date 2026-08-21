// Shared logging util for the runners so we can watch what happens without a dev console open.
// The log/warn/error functions are context aware: on the main thread they append a styled line to
// the visible DOM, inside a worker they forward the entry to the main thread which appends it there.

type Level = 'log' | 'warn' | 'error';

interface LogMessage {
	__log: {
		level: Level
		message: string
	}
}

const isWorker = 'WorkerGlobalScope' in self;

const COLORS: Record<Level, string> = {
	log: '#dddddd',
	warn: '#e5c07b',
	error: '#e06c75',
};

export function log(message: string) {
	emit('log', message);
}
export function warn(message: string) {
	emit('warn', message);
}
export function error(message: string) {
	emit('error', message);
}

function emit(level: Level, message: string) {
	console[level](message);

	if(isWorker) {
		self.postMessage({ __log: { level, message } } satisfies LogMessage);
	} else {
		appendToDom(level, message);
	}
}

// Main thread only - listen for logs forwarded from a worker and surface uncaught worker errors
export function attachWorkerLogging(worker: Worker) {
	worker.addEventListener('message', (e: MessageEvent) => {
		if(e.data && (e.data as Partial<LogMessage>).__log) {
			let { level, message } = (e.data as LogMessage).__log;
			appendToDom(level, message);
		}
	});
	worker.addEventListener('error', (e: ErrorEvent) => {
		appendToDom('error', `worker error: ${e.message} (${e.filename}:${e.lineno})`);
	});
	worker.addEventListener('messageerror', () => {
		appendToDom('error', 'worker messageerror: failed to deserialize a message');
	});
}

// Main thread only - surface uncaught errors/rejections on the page instead of only the dev console
export function captureGlobalErrors() {
	window.addEventListener('error', (e: ErrorEvent) => {
		appendToDom('error', `uncaught error: ${e.message} (${e.filename}:${e.lineno})`);
	});
	window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
		appendToDom('error', `unhandled rejection: ${e.reason}`);
	});
}

let container: HTMLElement | undefined;
function getContainer(): HTMLElement {
	if(!container) {
		container = document.getElementById('app') ?? document.body;
		container.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
		container.style.fontSize = '13px';
		container.style.lineHeight = '1.5';
		container.style.whiteSpace = 'pre-wrap';
		container.style.padding = '12px';
		container.style.background = '#1e1e1e';
		container.style.color = '#dddddd';
		container.style.minHeight = '100vh';
	}

	return container;
}
function appendToDom(level: Level, message: string) {
	const line = document.createElement('div');
	line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
	line.style.color = COLORS[level];
	getContainer().appendChild(line);
	// Keep the newest line in view
	line.scrollIntoView(false);
}
