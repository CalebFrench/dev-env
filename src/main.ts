import { homedir } from 'os';
import path from 'path';
import fs from 'fs';
import ChildProc from 'child_process';

const CONFIG_FILE = "config.json";
const CONFIG_DIR = path.join(homedir(), ".dev-env");
if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR);
}

type Env = {
    name: string;
    hash: string;
    baseImage: string;
    sshKey?: string;
    repo?: string;
};

type Config = {
    engine: "docker";
    enginePath: string;
    sshPath: string;
    envs: Record<string, Env>;
};

function load(): Config {
    const file = path.join(CONFIG_DIR, CONFIG_FILE);
    if (!fs.existsSync(file)) {
        return {
            engine: "docker",
            enginePath: "",
            sshPath: "",
            envs: {}
        };
    }
    const content = fs.readFileSync(file);
    return JSON.parse(content.toString()) as Config;
}

function save(config: Config) {
    const content = JSON.stringify(config, null, 2);
    fs.writeFileSync(path.join(CONFIG_DIR, CONFIG_FILE), content);
}

abstract class Engine {
    protected readonly config: Config;

    constructor(config: Config) {
        this.config = config;
    }

    public abstract createEnv(env: Env, force: boolean): void;
}

// TODO: use socket to talk with docker
class DockerEngine extends Engine {
    private readonly exe = "docker";

    constructor(config: Config) {
        super(config);
    }
    
    public createEnv(env: Omit<Env, "hash">, force: boolean): Env {
        if (!force && this.config.envs[env.name]) {
            throw new Error(`dev-env already exists with name: ${env.name}`);
        }
        console.log(`creating env ${env.name}`);

        console.log("  creating volume...");
        let child = this.exec([ "volume", "create", env.name ]);

        const sshArgs = [];
        if (env.sshKey) {
            const key = path.join(this.config.sshPath, env.sshKey);
            console.log(key);
            sshArgs.push("-v", `${key}:/root/.ssh/id_rsa`);
        }

        if (env.repo) {
            console.log("  cloning repo...");
            child = this.exec([ "run", "--rm",
                "-v", `${env.name}:/workspace`,
                ...sshArgs, "local/git",
                "clone", env.repo, `/workspace/${env.name}`],
                "inherit");
            if (child.status != 0) {
                throw new Error(`failed to clone repo: ${env.repo}`);
            }
        }

        this.config.envs[env.name] = {
            ...env,
            hash: env.name.split("").map((char) => char.charCodeAt(0).toString(16)).join('')
        };
        return this.config.envs[env.name];
    }

    public startEnv(name: string) {
        const env = this.config.envs[name];
        if (!env) {
            throw new Error(`could not find env with name: ${name}`);
        }
       
        const sshArgs: string[] = [];
        if (env.sshKey) {
            const key = path.join(this.config.sshPath, env.sshKey);
            sshArgs.push("-v", `${key}:/root/.ssh/id_rsa`);
        }
    
        const extraArgs: string[] = [
            "-p", "8080:8080", "--mount", "type=volume,source=pnpm,destination=/pnpm"
        ];
        const child = this.exec([ "run", "-d", "--rm", "--name", env.name,
            ...extraArgs, ...sshArgs,
            "-v", `${env.name}:/workspace`,
            "--workdir", `/workspace`,
            env.baseImage]);
        if (child.status != 0) {
            throw new Error(`failed to start env: ${env.name}`);
        }
    }

    public attachEnv(name: string) {
        const env = this.config.envs[name];
        if (!env) {
            throw new Error(`could not find env with name: ${name}`);
        }

        const child = ChildProc.spawnSync("code", [
            `--folder-uri=vscode-remote://attached-container+${env.hash}/workspace/${env.name}`
        ]);
        
        if (child.error) {
            console.log(child.error);
            throw child.error;
        }
        if (child.status != 0) {
            throw new Error(`failed to start env: ${env.name}`);
        }
    }

    public stopEnv(name: string) {
        const env = this.config.envs[name];
        if (!env) {
            throw new Error(`could not find env with name: ${name}`);
        }
    
        const child = this.exec([ "stop", "--name", env.name ]);
        if (child.status != 0) {
            throw new Error(`failed to start env: ${env.name}`);
        }
    }

    public removeEnv(name: string) {
        const env = this.config.envs[name];
        if (!env) {
            throw new Error(`could not find env with name: ${name}`);
        }
        
        const child = this.exec([ "volume", "rm", env.name ]);
        if (child.status != 0) {
            throw new Error(`failed to start env: ${env.name}`);
        }

        delete this.config.envs[env.name];
    }

    private exec(args: string[], stdio: "pipe"|"inherit" = "pipe") {
        const child = ChildProc.spawnSync(this.exe, args, { stdio });
        
        if (child.error) {
            console.log(child.error);
            throw child.error;
        }
        return child;
    }
}

class Args {
    private readonly args: string[];
    private index = 0;

    constructor(args: string[]) {
        this.args = [...args];
        this.args.shift();
        this.args.shift();
    }

    public pos(name: string): string|undefined {
        if (this.index >= this.args.length) {
            return;
        }
        return this.args[this.index++];
    }

    public posReq(name: string): string {
        const value = this.pos(name);
        if (!value) {
            throw new Error(`missing positional arg(${this.index}) ${name}`);
        }
        return value;
    }

    public named(name: string): string|undefined {
        const index = this.args.indexOf(name)
        if (index < 0) {
            return;
        } else if (index + 1 >= this.args.length) {
            throw new Error(`missing value for named arg ${name}`);
        }

        return this.args.splice(index, 2)[1];
    }

    public namedReq(name: string): string {
        const value = this.named(name);
        if (!value) {
            throw new Error(`missing named arg ${name}`);
        }
        return value;
    }
}

function HasRequiredConfig(config: Config) {
    return !!config.sshPath;
}

function help() {
    console.log(
`dev-env cmd [options] - manage development environments via docker
  help   - display the help message
  config - update various settings for this utility
  create - create a new development environment
  start  - start an existing development environment
  stop   - stop a running development environment
  rm     - delete an existing development environment
`);
}

try {
    const args = new Args(process.argv);
    
    const config = load();
    const engine = new DockerEngine(config);

    const cmd = args.posReq("cmd");
    if ("help" === cmd) {
        help();
    } else if ("config" === cmd) {
        const sshPath = args.named("sshPath");
        config.sshPath = sshPath ?? "";
    } else if (!HasRequiredConfig(config)) {
        throw new Error("please run 'dev-env config' first");
    } else if ("create" === cmd) {
        const name = args.posReq("name");
        const baseImage = args.named("--image") ?? "local/node";
        const repo = args.named("--repo");
        const sshKey = args.named("--key");
        engine.createEnv({
            name,
            baseImage,
            sshKey,
            repo
        }, true);
        // engine.startEnv(name);
    } else if (["start", "run"].includes(cmd)) {
        const name = args.posReq("name");
        engine.startEnv(name);
    } else if ("stop" === cmd) {
        const name = args.posReq("name");
        engine.stopEnv(name);
    } else if ("rm" === cmd) {
        const name = args.posReq("name");
        engine.removeEnv(name);
    } else {
        help();
    }

    save(config);
} catch (err) {
    console.error(`${err}`);
}
