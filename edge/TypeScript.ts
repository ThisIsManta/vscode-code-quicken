import { RootConfigurations } from './global'
import JavaScript from './JavaScript'

export default class TypeScript extends JavaScript {
	constructor(baseConfig: RootConfigurations) {
		super(baseConfig)

		this.supportedLanguage = /^typescript(react)?/
	}

	protected getLanguageOptions() {
		return this.baseConfig.typescript
	}
}