export class SlackManifestCreateError extends Error {
	constructor(
		message: string,
		public errors?: { message: string; pointer: string }[],
	) {
		super(message);
	}
}

export class SlackManifestUpdateError extends Error {
	constructor(
		message: string,
		public errors?: { message: string; pointer: string }[],
	) {
		super(message);
	}
}

export class SlackManifestExportError extends Error {}
