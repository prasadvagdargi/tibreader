import Volume from './volume';
import { SnapshotFS } from './fs/types';


export interface ProductInfo {
	name: string;
	version: {
		major: number;
		minor: number;
	}
	build_number: number;
}


export interface SliceConfig {
	machine_id?: string; /**< Known in windows as a 'computer_id' */

	// Mainly present on Mac backups
	// NOTE: For full-disk backups, these may not be present
	includePaths?: string[];
	excludePaths?: string[];

	// Mainly present on Windows backups
	productinfo?: ProductInfo;
	task_id?: string;
	compression?: string; /**< NOTE: A missing value will be present on Mac implying compression is present but not configurable */
	encryption?: string;
}


/** 'files' for file and folder backups, 'disk' for disk and partition images */
export type SliceKind = 'files' | 'disk';

/**
 * One backup point in time. Full backups have no parent; incremental ones build on their parent.
 *
 * NOTE: Each version of the format will have a subclass of this that caches volume specific details on the slice
 */
abstract class Slice {

	public parent: Slice|null;
	public volumes: Volume[];

	public abstract get id(): Buffer;
	public abstract get creationTime(): Date;

	/** What the backup point holds: files and folders, or a disk/partition image */
	public get kind(): SliceKind {
		return 'files';
	}

	// TODO: Also verify that the xml configuration matches the sniffed settings (include paths, compression, encryption)
	public abstract get config(): SliceConfig;

	protected constructor(volumes: Volume[], parent: Slice|null) {
		this.volumes = volumes;
		this.parent = parent;
	}

	/**
	 * Read-only view of the files in this backup point
	 */
	public abstract openFileSystem(): Promise<SnapshotFS>;

	public abstract close() : Promise<void>;
}

export default Slice;
