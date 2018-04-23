import JavaScript, { FileItem } from './JavaScript'

export default class TypeScript extends JavaScript {
	protected SUPPORTED_LANGUAGE = /^typescript(react)?/i
	protected SUPPORTED_EXTENSION = /^(j|t)sx?$/

	protected rejectSomeFiles(item: FileItem) {
		return false
	}

	protected getLanguageOptions() {
		return this.baseConfig.typescript
	}
}