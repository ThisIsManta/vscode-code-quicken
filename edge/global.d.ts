interface FileConfiguration {
	path: string | Array<string>
	code: string | string[]
	when?: string
	interpolate: (object) => string
	omitIndexInSelectFilePath: boolean
	omitExtensionInSelectFilePath: boolean | string
	insertAt: string
}

interface NodeConfiguration {
	name: string
	code: string | string[]
	when?: string
	insertAt: string
}
