#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

interface Options {
	allowDirty: boolean;
	allowProtectedBranch: boolean;
	base: string | null;
	binary: string | null;
	dryRun: boolean;
	fetchRemote: string;
	help: boolean;
	noInstall: boolean;
	noPush: boolean;
	noSmokeTest: boolean;
	pushBranch: string | null;
	pushRemote: string;
}

interface RunOptions {
	allowFailure?: boolean;
	capture?: boolean;
	cwd?: string;
	dryRun?: boolean;
	env?: NodeJS.ProcessEnv;
	quiet?: boolean;
}

interface RunResult {
	exitCode: number;
	stdout: string;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const builtBinaryPath = path.join(codingAgentDir, "dist", "omp");
const sourceLauncherPath = path.join(codingAgentDir, "scripts", "omp");
const protectedBranches: Record<string, true> = { main: true, master: true, develop: true, trunk: true };

const usage = `Usage: bun run update:feature-branch [options]

Fetch upstream, rebase the current feature branch onto upstream/main, force-push
the rebased branch to origin with a lease, rebuild omp, smoke-test the build,
and replace the currently installed omp binary.

Options:
  --fetch-remote <name>        Remote to fetch/rebase from (default: upstream)
  --push-remote <name>         Remote to force-push to (default: origin)
  --remote <name>              Use one remote for both fetch and push
  --base <ref>                 Rebase base (default: <fetch-remote>/main)
  --branch <name>              Remote branch to update (default: current branch)
  --binary <path>              omp binary to replace (default: PATH lookup)
  --allow-dirty                Rebase with git --autostash instead of requiring a clean worktree
  --allow-protected-branch     Allow updating main/master/develop/trunk
  --no-push                    Rebase/build locally without pushing
  --no-install                 Skip bun install --frozen-lockfile after rebase
  --no-smoke-test              Skip compiled-binary smoke checks
  --dry-run                    Print planned mutating commands without running them
  -h, --help                   Show this help
`;

function readFlagValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function parseArgs(args: string[]): Options {
	const options: Options = {
		allowDirty: false,
		allowProtectedBranch: false,
		base: null,
		binary: null,
		dryRun: false,
		fetchRemote: "upstream",
		help: false,
		noInstall: false,
		noPush: false,
		noSmokeTest: false,
		pushBranch: null,
		pushRemote: "origin",
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--fetch-remote") {
			options.fetchRemote = readFlagValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--fetch-remote=")) {
			options.fetchRemote = arg.slice("--fetch-remote=".length);
			continue;
		}
		if (arg === "--push-remote") {
			options.pushRemote = readFlagValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--push-remote=")) {
			options.pushRemote = arg.slice("--push-remote=".length);
			continue;
		}
		if (arg === "--remote") {
			const remote = readFlagValue(args, index, arg);
			options.fetchRemote = remote;
			options.pushRemote = remote;
			index += 1;
			continue;
		}
		if (arg.startsWith("--remote=")) {
			const remote = arg.slice("--remote=".length);
			options.fetchRemote = remote;
			options.pushRemote = remote;
			continue;
		}
		if (arg === "--base") {
			options.base = readFlagValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--base=")) {
			options.base = arg.slice("--base=".length);
			continue;
		}
		if (arg === "--branch") {
			options.pushBranch = readFlagValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--branch=")) {
			options.pushBranch = arg.slice("--branch=".length);
			continue;
		}
		if (arg === "--binary") {
			options.binary = readFlagValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--binary=")) {
			options.binary = arg.slice("--binary=".length);
			continue;
		}
		switch (arg) {
			case "--allow-dirty":
				options.allowDirty = true;
				break;
			case "--allow-protected-branch":
				options.allowProtectedBranch = true;
				break;
			case "--no-push":
				options.noPush = true;
				break;
			case "--no-install":
				options.noInstall = true;
				break;
			case "--no-smoke-test":
				options.noSmokeTest = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	if (!options.fetchRemote) throw new Error("--fetch-remote cannot be empty");
	if (!options.pushRemote) throw new Error("--push-remote cannot be empty");
	if (options.base === "") throw new Error("--base cannot be empty");
	if (options.pushBranch === "") throw new Error("--branch cannot be empty");
	if (options.binary === "") throw new Error("--binary cannot be empty");

	return options;
}

function quoteArg(arg: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}


function section(title: string): void {
	console.log(`\n== ${title} ==`);
}

async function runCommand(command: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const cwd = options.cwd ?? repoRoot;
	const formatted = command.map(quoteArg).join(" ");
	if (options.dryRun) {
		console.log(`DRY RUN ${formatted}`);
		return { exitCode: 0, stdout: "" };
	}

	if (!options.quiet) {
		console.log(`$ ${formatted}`);
	}

	const proc = Bun.spawn([...command], {
		cwd,
		env: options.env ?? Bun.env,
		stderr: options.quiet ? "pipe" : "inherit",
		stdout: options.capture ? "pipe" : "inherit",
	});
	const stdoutPromise = options.capture
		? new Response(proc.stdout as ReadableStream<Uint8Array>).text()
		: Promise.resolve("");
	const stderrPromise = options.quiet
		? new Response(proc.stderr as ReadableStream<Uint8Array>).text()
		: Promise.resolve("");
	const exitCode = await proc.exited;
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

	if (exitCode !== 0 && !options.allowFailure) {
		const details = stderr.trim() ? `\n${stderr.trim()}` : "";
		throw new Error(`Command failed with exit code ${exitCode}: ${formatted}${details}`);
	}

	return { exitCode, stdout };
}

async function captureText(command: readonly string[], options: Omit<RunOptions, "capture"> = {}): Promise<string> {
	const result = await runCommand(command, { ...options, capture: true, quiet: true });
	return result.stdout.trim();
}

async function currentBranch(): Promise<string> {
	const branch = await captureText(["git", "branch", "--show-current"]);
	if (!branch) {
		throw new Error("Refusing to update a detached HEAD; check out a feature branch first.");
	}
	return branch;
}

async function assertCleanWorktree(allowDirty: boolean): Promise<void> {
	if (allowDirty) return;
	const status = await captureText(["git", "status", "--porcelain=v1"]);
	if (status) {
		throw new Error("Working tree has uncommitted changes; commit/stash them or pass --allow-dirty.");
	}
}

async function assertRefExists(ref: string, dryRun: boolean): Promise<void> {
	if (dryRun) return;
	const result = await runCommand(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		allowFailure: true,
		capture: true,
		quiet: true,
	});
	if (result.exitCode !== 0) {
		throw new Error(`Rebase base not found after fetch: ${ref}`);
	}
}

function resolveBinaryPath(explicitPath: string | null, dryRun: boolean): string {
	if (explicitPath) return path.resolve(process.cwd(), explicitPath);

	const resolved = $which("omp");
	if (!resolved) {
		if (dryRun) return path.resolve(process.cwd(), "omp");
		throw new Error("Could not find omp on PATH; pass --binary <path>.");
	}
	return path.resolve(resolved);
}

async function assertReplaceTargetIsSafe(binaryPath: string, dryRun: boolean): Promise<void> {
	if (path.resolve(binaryPath) === sourceLauncherPath) {
		throw new Error(
			`Refusing to overwrite the checked-in dev launcher: ${sourceLauncherPath}\n` +
				"Pass --binary <installed-omp-path> to replace a compiled binary instead.",
		);
	}

	if (dryRun) return;
	const stat = await fs.lstat(binaryPath);
	if (stat.isDirectory()) {
		throw new Error(`Refusing to replace directory: ${binaryPath}`);
	}
}

async function assertBuiltBinaryExists(dryRun: boolean): Promise<void> {
	if (dryRun) return;
	const stat = await fs.stat(builtBinaryPath);
	if (!stat.isFile()) {
		throw new Error(`Build did not produce a binary file: ${builtBinaryPath}`);
	}
}

async function withSmokeEnv<T>(callback: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-smoke-"));
	const home = path.join(tempDir, "home");
	const xdgDataHome = path.join(tempDir, "xdg");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(xdgDataHome, { recursive: true });
	try {
		return await callback({
			...Bun.env,
			HOME: home,
			XDG_DATA_HOME: xdgDataHome,
		});
	} finally {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
}

async function smokeBuiltBinary(options: Options): Promise<void> {
	if (options.noSmokeTest) return;
	if (options.dryRun) {
		await runCommand([builtBinaryPath, "--version"], { dryRun: true });
		await runCommand([builtBinaryPath, "--smoke-test"], { dryRun: true });
		return;
	}
	await withSmokeEnv(async env => {
		await runCommand([builtBinaryPath, "--version"], { env });
		await runCommand([builtBinaryPath, "--smoke-test"], { env });
	});
}

async function smokeInstalledBinary(binaryPath: string, options: Options): Promise<void> {
	if (options.noSmokeTest) return;
	if (options.dryRun) {
		await runCommand([binaryPath, "--version"], { dryRun: true });
		return;
	}
	await withSmokeEnv(async env => {
		await runCommand([binaryPath, "--version"], { env });
	});
}

async function replaceBinary(binaryPath: string, dryRun: boolean): Promise<void> {
	if (dryRun) {
		console.log(`DRY RUN install ${builtBinaryPath} -> ${binaryPath}`);
		return;
	}

	const tempPath = path.join(path.dirname(binaryPath), `.omp-update-${process.pid}-${Date.now()}`);
	try {
		await Bun.write(tempPath, Bun.file(builtBinaryPath));
		await fs.chmod(tempPath, 0o755);
		await fs.rename(tempPath, binaryPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage);
		return;
	}

	const localBranch = await currentBranch();
	const pushBranch = options.pushBranch ?? localBranch;
	if (!options.allowProtectedBranch && protectedBranches[pushBranch]) {
		throw new Error(`Refusing to force-push protected branch '${pushBranch}'.`);
	}
	await assertCleanWorktree(options.allowDirty);
	const binaryPath = resolveBinaryPath(options.binary, options.dryRun);
	await assertReplaceTargetIsSafe(binaryPath, options.dryRun);

	section("Git sync");
	await runCommand(["git", "fetch", options.fetchRemote, "--prune"], { dryRun: options.dryRun });
	const base = options.base ?? `${options.fetchRemote}/main`;
	await assertRefExists(base, options.dryRun);
	await runCommand(["git", "rebase", ...(options.allowDirty ? ["--autostash"] : []), base], { dryRun: options.dryRun });
	if (!options.noPush) {
		await runCommand(
			["git", "push", "--force-with-lease", "--set-upstream", options.pushRemote, `HEAD:refs/heads/${pushBranch}`],
			{ dryRun: options.dryRun },
		);
	}

	section("Build omp");
	if (!options.noInstall) {
		await runCommand(["bun", "install", "--frozen-lockfile"], { dryRun: options.dryRun });
	}
	await runCommand(["bun", "--cwd=packages/coding-agent", "run", "build"], { dryRun: options.dryRun });
	await assertBuiltBinaryExists(options.dryRun);
	await smokeBuiltBinary(options);

	section("Replace installed omp");
	await replaceBinary(binaryPath, options.dryRun);
	await smokeInstalledBinary(binaryPath, options);

	console.log(
		`\nUpdated ${localBranch}: rebased onto ${base}${options.noPush ? "" : ` and force-pushed to ${options.pushRemote}/${pushBranch}`}.`,
	);
	console.log(`Replaced omp binary at ${binaryPath}.`);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
