import { runAccessCommand } from "./access/command.js"

// Standalone entry; deliberately does not import the runtime index/bootstrap.
const outputFailure = (): void => {
	process.exitCode = 1
}
process.stdout.on("error", outputFailure)
process.stderr.on("error", outputFailure)
void runAccessCommand(process.argv.slice(2))
	.then(result => {
		const output = result.exitCode === 0 ? process.stdout : process.stderr
		output.write(`${result.lines.join("\n")}\n`)
		process.exitCode = result.exitCode
	})
	.catch(() => {
		process.stderr.write(
			"ACCESS_COMMAND_UNAVAILABLE: Access command unavailable.\n",
		)
		process.exitCode = 1
	})
