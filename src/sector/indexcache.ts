import fs from 'node:fs';
import path from 'node:path';
import { cachePath } from '../cachedir';
import { ChunkMap } from './chunkmap';
import { SectorGeometry } from './image';
import { warn } from '../log';


const MAGIC = Buffer.from('TIBCMAP1');

/*
 * File layout: "TIBCMAP1", uint32 cluster size, uint32 clusters per block, uint32 count,
 * then count float64 offsets and count uint32 lengths (little-endian).
 */

export function loadCachedChunkMap(key: string): { map: ChunkMap; geometry: SectorGeometry } | null {
	let file = cachePath('chunkmap', key);
	if(!file || !fs.existsSync(file)) {
		return null;
	}

	try {
		let b = fs.readFileSync(file);
		if(b.length < 20 || !b.subarray(0, 8).equals(MAGIC)) {
			return null;
		}
		let clusterSize = b.readUInt32LE(8);
		let clustersPerBlock = b.readUInt32LE(12);
		let n = b.readUInt32LE(16);
		if(b.length !== 20 + n * 12) {
			return null;
		}
		let offsets = new Float64Array(n);
		let lengths = new Uint32Array(n);
		for(let i = 0; i < n; i++) {
			offsets[i] = b.readDoubleLE(20 + i * 8);
			lengths[i] = b.readUInt32LE(20 + n * 8 + i * 4);
		}
		return { map: { offsets, lengths }, geometry: { clusterSize, clustersPerBlock } };
	}
	catch(e: any) {
		warn('Ignoring an unreadable index cache file: ' + e.message);
		return null;
	}
}

export function saveCachedChunkMap(key: string, map: ChunkMap, geometry: SectorGeometry) {
	let file = cachePath('chunkmap', key);
	if(!file) {
		return;
	}

	try {
		let n = map.offsets.length;
		let b = Buffer.alloc(20 + n * 12);
		MAGIC.copy(b, 0);
		b.writeUInt32LE(geometry.clusterSize, 8);
		b.writeUInt32LE(geometry.clustersPerBlock, 12);
		b.writeUInt32LE(n, 16);
		for(let i = 0; i < n; i++) {
			b.writeDoubleLE(map.offsets[i], 20 + i * 8);
			b.writeUInt32LE(map.lengths[i], 20 + n * 8 + i * 4);
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// Write then rename, so a crash never leaves half a file behind
		let tmp = file + '.' + process.pid + '.tmp';
		fs.writeFileSync(tmp, b);
		fs.renameSync(tmp, file);
	}
	catch(e: any) {
		warn('Could not save the disk-image index (it will be rebuilt next time): ' + e.message);
	}
}
