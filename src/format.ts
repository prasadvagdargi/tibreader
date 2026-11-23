/** "1536" -> "1.5 KiB" */
export function formatSize(bytes: number): string {
	let units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let v = bytes;
	let i = 0;
	while(v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}
