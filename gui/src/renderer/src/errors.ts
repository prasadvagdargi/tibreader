import type { ErrorCode } from '../../shared/api';

export interface FriendlyError {
	title: string;
	body: string;
}

/**
 * Plain-language explanations of why a backup couldn't be opened or read
 */
export function friendlyError(code: ErrorCode): FriendlyError {
	switch(code) {
		case 'encrypted':
			return {
				title: 'This backup is password-protected',
				body: 'TibReader can\'t open encrypted backups in this app yet. Use Acronis True Image to restore files from it. (The tib command line can try .tibx backups with --password, experimentally.)',
			};
		case 'wrong-password':
			return {
				title: 'Wrong password',
				body: 'That password doesn\'t open this backup.',
			};
		case 'disk-image':
			return {
				title: 'This is a whole-disk backup',
				body: 'Disk and partition backups (sector-by-sector) can\'t be opened yet. File and folder backups work.',
			};
		case 'missing-part':
			return {
				title: 'Part of this backup is missing',
				body: 'This backup is made of several .tib files. Put all of them in the same folder, then try again.',
			};
		case 'unexpected-name':
			return {
				title: 'This backup file was renamed',
				body: 'TibReader finds the parts of a Windows backup by their names, like MyBackup_full_b1_s1_v1.tib. Give the file its original name, then try again.',
			};
		case 'not-a-backup':
			return {
				title: 'This isn\'t an Acronis backup',
				body: 'Choose a .tib or .tibx file made by Acronis True Image.',
			};
		case 'damaged':
			return {
				title: 'This backup looks damaged',
				body: 'Part of it doesn\'t match the backup format. If you have another copy of the backup, try that one.',
			};
		case 'unsupported':
			return {
				title: 'This backup uses something TibReader can\'t read yet',
				body: 'Your backup is fine; TibReader just doesn\'t understand this part of the format yet.',
			};
		case 'not-found':
			return {
				title: 'The backup file isn\'t there',
				body: 'It may have been moved, renamed or deleted, or the drive it\'s on isn\'t connected.',
			};
		case 'io':
			return {
				title: 'The file couldn\'t be read',
				body: 'Check that the drive is connected and that you can open files in that folder.',
			};
		case 'engine':
			return {
				title: 'The backup stopped responding',
				body: 'Open the backup again. If this keeps happening, the backup may be damaged.',
			};
		default:
			return {
				title: 'Something went wrong',
				body: 'TibReader ran into an unexpected problem.',
			};
	}
}
