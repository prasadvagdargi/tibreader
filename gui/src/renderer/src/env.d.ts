import type { TibBridge } from '../../shared/api';

declare global {
	interface Window {
		tib: TibBridge;
	}
}

export {};
