import { RootConfigurations } from './global'
import JavaScript from './JavaScript'

export default class TypeScript extends JavaScript {
	protected WORKING_LANGUAGE = /^typescript(react)?/i
	protected WORKING_EXTENSION = /^(j|t)sx?$/

	constructor(baseConfig: RootConfigurations) {
		super(baseConfig)

		this.allowTypeScriptFiles = true
	}

	protected getLanguageOptions() {
		return this.baseConfig.typescript
	}
}