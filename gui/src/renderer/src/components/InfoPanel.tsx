import { useEffect, useState, type ReactNode } from 'react';
import {
	Badge, Button, Caption1, DrawerBody, DrawerHeader, DrawerHeaderTitle, makeStyles, OverlayDrawer, Spinner, Subtitle2, Text, tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import type { Contents, Session } from '../../../shared/api';
import { call, errorMessage } from '../api';
import { baseName, dirName, formatCount, formatLongDate, formatSize, plural } from '../format';


const useStyles = makeStyles({
	section: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		marginBottom: '22px',
	},
	grid: {
		display: 'grid',
		gridTemplateColumns: '130px 1fr',
		columnGap: '12px',
		rowGap: '6px',
	},
	label: {
		color: tokens.colorNeutralForeground3,
	},
	value: {
		wordBreak: 'break-word',
	},
	file: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 0',
		borderBottom: '1px solid ' + tokens.colorNeutralStroke3,
	},
	fileName: {
		flex: 1,
		minWidth: 0,
		wordBreak: 'break-all',
	},
});


function Row(props: { label: string; children: ReactNode }) {
	let s = useStyles();
	return (
		<>
			<Text className={s.label}>{props.label}</Text>
			<Text className={s.value}>{props.children}</Text>
		</>
	);
}


export function InfoPanel(props: { open: boolean; onClose: () => void; session: Session; slice: number }) {
	let s = useStyles();
	let { info } = props.session;
	let [contents, setContents] = useState<Map<number, Contents | string>>(() => new Map());

	useEffect(() => {
		if(!props.open || contents.has(props.slice)) {
			return;
		}
		let n = props.slice;
		call(props.session.id, 'contents', n).then(
			(c) => setContents((m) => new Map(m).set(n, c)),
			(e) => setContents((m) => new Map(m).set(n, errorMessage(e)))
		);
	}, [props.open, props.slice, props.session.id, contents]);

	let point = info.slices[props.slice - 1];
	let c = contents.get(props.slice);
	let product = point?.config.productinfo;
	let totalSize = info.volumes.reduce((sum, v) => sum + v.size, 0);

	return (
		<OverlayDrawer open={props.open} position="end" size="medium" onOpenChange={(_e, d) => { if(!d.open) { props.onClose(); } }}>
			<DrawerHeader>
				<DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={props.onClose} />}>
					Backup info
				</DrawerHeaderTitle>
			</DrawerHeader>
			<DrawerBody>
				<section className={s.section}>
					<Subtitle2>Backup</Subtitle2>
					<div className={s.grid}>
						<Row label="Name">{info.name}</Row>
						<Row label="Kind">{info.format} file and folder backup</Row>
						<Row label="Backup points">{formatCount(info.slices.length)}</Row>
						<Row label="Size on disk">{formatSize(totalSize)}</Row>
						<Row label="Location">{dirName(info.file)}</Row>
					</div>
				</section>

				{point && (
					<section className={s.section}>
						<Subtitle2>This backup point ({props.slice} of {info.slices.length})</Subtitle2>
						<div className={s.grid}>
							<Row label="Made">{formatLongDate(Date.parse(point.created))}</Row>
							<Row label="Type">{point.incremental ? 'Incremental (only changes since the one before)' : 'Full'}</Row>
							<Row label="Contents">
								{c === undefined && <Spinner size="extra-tiny" label="Counting..." labelPosition="after" />}
								{typeof c === 'string' && c}
								{c && typeof c === 'object' && (
									plural(c.files, 'file', 'files') + ', ' + plural(c.folders, 'folder', 'folders') + ', ' + formatSize(c.bytes)
								)}
							</Row>
							{product && <Row label="Made with">{product.name} {product.version.major}.{product.version.minor} (build {product.build_number})</Row>}
							{point.config.compression && <Row label="Compression">{point.config.compression}</Row>}
							{point.config.encryption && <Row label="Encryption">{point.config.encryption}</Row>}
							{point.config.machine_id && <Row label="Computer ID">{point.config.machine_id}</Row>}
							{point.config.includePaths && point.config.includePaths.length > 0 && (
								<Row label="Backed up">{point.config.includePaths.join(', ')}</Row>
							)}
						</div>
					</section>
				)}

				<section className={s.section}>
					<Subtitle2>Files</Subtitle2>
					{info.volumes.map((v) => (
						<div key={v.file} className={s.file}>
							<Text className={s.fileName}>{baseName(v.file)}</Text>
							<Caption1>{formatSize(v.size)}</Caption1>
							{!v.headerChecksumOk && <Badge color="danger" appearance="tint">Header checksum mismatch</Badge>}
						</div>
					))}
				</section>
			</DrawerBody>
		</OverlayDrawer>
	);
}
