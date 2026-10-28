const sizeFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });
const countFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const longDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

/** Sizes the way File Explorer shows them: 1,024-byte units, three significant digits */
export function formatSize(bytes: number): string {
	if(bytes < 1024) {
		return countFormat.format(bytes) + (bytes === 1 ? ' byte' : ' bytes');
	}

	let units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let v = bytes / 1024;
	let i = 0;
	while(v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return sizeFormat.format(v) + ' ' + units[i];
}

export function formatCount(n: number): string {
	return countFormat.format(n);
}

export function formatDate(ms: number): string {
	return dateFormat.format(new Date(ms));
}

export function formatLongDate(ms: number): string {
	return longDateFormat.format(new Date(ms));
}

export function plural(n: number, one: string, many: string): string {
	return formatCount(n) + ' ' + (n === 1 ? one : many);
}

/** The folder part of a Windows or POSIX path */
export function dirName(file: string): string {
	let i = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
	return i > 0 ? file.slice(0, i) : file;
}

export function baseName(file: string): string {
	let i = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
	return i >= 0 ? file.slice(i + 1) : file;
}

/** "5 minutes ago", "yesterday", or a date */
export function formatRelative(ms: number, now = Date.now()): string {
	let rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	let secs = Math.round((ms - now) / 1000);
	let abs = Math.abs(secs);
	if(abs < 60) {
		return rtf.format(0, 'second');
	}
	if(abs < 3600) {
		return rtf.format(Math.round(secs / 60), 'minute');
	}
	if(abs < 86400) {
		return rtf.format(Math.round(secs / 3600), 'hour');
	}
	if(abs < 7 * 86400) {
		return rtf.format(Math.round(secs / 86400), 'day');
	}
	return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms));
}
