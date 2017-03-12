interface FileConfiguration {
	path: string | Array<string>
	code: string | string[]
	when?: string
	interpolate: (object) => string
	omitIndexFile: boolean
	omitExtensionInFilePath: boolean | string
	insertAt: string
}

interface NodeConfiguration {
	name: string
	code: string | string[]
	when?: string
	insertAt: string
}
