//@ts-check
// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

import * as child_process from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as yaml from "js-yaml";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as shell_quote from "shell-quote";
import * as tmp from "tmp";
import * as util from "util";
import * as vscode from "vscode";

import * as extension from "../../../../extension";
import * as requests from "../../../requests";
import * as utils from "../../../utils";
import { rosApi } from "../../../../ros/ros";

const promisifiedExec = util.promisify(child_process.exec);

interface ILaunchRequest {
    nodeName: string;
    debugger: string;
    executable: string;
    arguments: string[];
    cwd: string;
    env: { [key: string]: string };
    symbolSearchPath?: string;
    additionalSOLibSearchPath?: string;
    sourceFileMap?: { [key: string]: string };
    launch?: string[];    // Scripts or executables to just launch without attaching a debugger
    attachDebugger?: string[];    // If specified, Scripts or executables to debug; otherwise attaches to everything not ignored
}

interface ICppEnvConfig {
    name: string;
    value: string;
}

function getExtensionFilePath(extensionFile: string): string {
    return path.resolve(extension.extPath, extensionFile);
}

export class LaunchResolver implements vscode.DebugConfigurationProvider {
    public static launchedNodesPID:Array<number> = [];//gets filled when you do a launch request. It exists so you can stop the nodes again
    // tslint:disable-next-line: max-line-length
    public async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder | undefined, config: requests.ILaunchRequest, token?: vscode.CancellationToken) {
        
        let target = config.target
        // handle both ways to specify the file: full path, and "pkg filename"
        {
            let find_launch_script = getExtensionFilePath(path.join("assets", "scripts", "ros2_get_filepath_from_package.py"));
            target = (await promisifiedExec(`/usr/bin/env python3 ${find_launch_script} ${target}`)).stdout
        }
        
        await fsp.access(target, fs.constants.R_OK);

        if (path.extname(target) !== ".py" && path.extname(target) !== ".xml" && path.extname(target) !== ".yaml") {
            throw new Error("Launch request requires an extension '.py', '.xml' or '.yaml'.");
        }

        const delay = ms => new Promise(res => setTimeout(res, ms));

        // Manage the status of the ROS2 Daemon, starting one if not present
        if (await rosApi.getCoreStatus() == false) {
            extension.outputChannel.appendLine("ROS Daemon is not active, attempting to start automatically");
            rosApi.startCore();

            // Wait for the core to start up to a timeout
            const timeout_ms: number = 30000;
            const interval_ms: number = 100;
            let timeWaited: number = 0;
            while (await rosApi.getCoreStatus() == false && 
                timeWaited < timeout_ms) {
                timeWaited += interval_ms;
                await delay(interval_ms);
            }

            extension.outputChannel.appendLine("Waited " + timeWaited + " for ROS2 Daemon to start. Proceeding without the Daemon.");
        }

        const rosExecOptions: child_process.ExecOptions = {
            env: {
                ...await extension.resolvedEnv(),
                ...config.env,
            },
        };

        extension.outputChannel.appendLine("Executing dumper with the following environment:");
        extension.outputChannel.appendLine(JSON.stringify(rosExecOptions.env));

        let ros2_launch_dumper = getExtensionFilePath(path.join("assets", "scripts", "ros2_launch_dumper.py"));

        let args = []
        if (config.arguments) {
            for (let arg of config.arguments) {
                args.push(`"${arg}"`);
            }
        }
        let flatten_args = args.join(' ')
        let ros2_launch_dumper_cmdLine = (process.platform === "win32") ?
            `python ${ros2_launch_dumper} "${target}" ${flatten_args}` :
            `/usr/bin/env python3 ${ros2_launch_dumper} "${target}" ${flatten_args}`;

        let result = await promisifiedExec(ros2_launch_dumper_cmdLine, rosExecOptions);

        if (result.stderr) {
            // Having stderr output is not nessesarily a problem, but it is useful for debugging
            extension.outputChannel.appendLine(`ROS2 launch processor produced stderr output:\r\n ${result.stderr}`);
        }        

        if (result.stdout.length == 0) {
            throw (new Error(`ROS2 launch processor was unable to produce a node list.\r\n ${result.stderr}`));
        }

        let commands = result.stdout.split(os.EOL);
        let outputOtherNodes = vscode.window.createOutputChannel(`Other ROS nodes`);
        outputOtherNodes.show();
        commands.forEach(async (command) => {
            if (!command || command =='') {
               return;
            }

            // trim to remove the tab character
            let process = command.trim().split(' ')[0];
            
            // delete the first (weirdly double-quoted) occurrence of "xterm"
            if(process == '"xterm"')
            {
                command = command.substring(command.indexOf(' ') + 1);
                process = command.trim().split(' ')[0];
            }
            
            
            const launchRequest = this.generateLaunchRequest(process, command, config);
            if (launchRequest != null) {
              this.executeLaunchRequest(launchRequest, false);
            } else {
                let process = child_process.exec(command, rosExecOptions, (err, out) => {
                    if (err) {
                        throw (new Error(`Error from ${command}:\r\n ${err}`));
                    }
                })
                
                //redirect process output to new terminal
                process.stdout.on('data', function(data){
                    outputOtherNodes.append(data);
                });
                process.stderr.on('data', function(data){
                    outputOtherNodes.append(data);
                });

                if(process.pid)
                    LaunchResolver.launchedNodesPID.push(process.pid);
            }
        });

        // @todo: error handling for Promise.all

        // Return null as we have spawned new debug requests
        return null;
    }
    
    public static stopLaunchedNodes() : void
    {
        LaunchResolver.launchedNodesPID.forEach(pid => child_process.exec(`kill $(ps -o pid= --ppid ${pid})`) );
        LaunchResolver.launchedNodesPID = [];
    }
    
    public stopLaunchedNodes() : void
    {
        LaunchResolver.stopLaunchedNodes();
    }

    private generateLaunchRequest(nodeName: string, command: string, config: requests.ILaunchRequest): ILaunchRequest {
        let parsedArgs: shell_quote.ParseEntry[];

        parsedArgs = shell_quote.parse(command);

        let executable = parsedArgs.shift().toString();

         // return rviz instead of rviz.exe, or spawner instead of spawner.py
         // This allows the user to run filter out genericly. 
        let executableName = path.basename(executable, path.extname(executable));
        
        let givenNodeName ="";
        {
            const searchTerm = '__node:=';
            let indexName = command.indexOf(searchTerm) + searchTerm.length;
            givenNodeName = command.substring(indexName, command.indexOf('"', indexName));
        }

        // If this executable is just launched, don't attach a debugger.
        if (config.launch && 
            config.launch.indexOf(executableName) != -1) {
          return null;
        }

        // Filter shell scripts - just launch them
        //  https://github.com/ms-iot/vscode-ros/issues/474 
        let executableExt = path.extname(executable);
        if (executableExt && 
            ["bash", "sh", "bat", "cmd", "ps1"].includes(executableExt)) {
          return null;
        }

        // If a specific list of nodes is specified, then determine if this is one of them.
        // If no specific nodes specifed, attach to all unless specifically ignored.
        if (config.attachDebugger == null ||
          config.attachDebugger.indexOf(givenNodeName) != -1) {

          const envConfig: { [key: string]: string; } = config.env;


          const request: ILaunchRequest = {
              nodeName: nodeName,
              debugger : config.debugger,
              executable: executable,
              arguments: parsedArgs.map((arg) => {
                  return arg.toString();
              }),
              cwd: config.cwd,
              env: {
                  ...extension.env,
                  ...envConfig,
              },
              symbolSearchPath: config.symbolSearchPath, 
              additionalSOLibSearchPath: config.additionalSOLibSearchPath, 
              sourceFileMap: config.sourceFileMap
          };

          return request;
        }

        return null;
    }

    private createPythonLaunchConfig(request: ILaunchRequest, stopOnEntry: boolean): IPythonLaunchConfiguration {
        const pythonLaunchConfig: IPythonLaunchConfiguration = {
            name: request.nodeName,
            type: "python",
            request: "launch",
            program: request.executable,
            args: request.arguments,
            env: request.env,
            stopOnEntry: stopOnEntry,
            justMyCode: false,
        };

        return pythonLaunchConfig;
    }

    private createCppLaunchConfig(request: ILaunchRequest, stopOnEntry: boolean): ICppvsdbgLaunchConfiguration | ICppdbgLaunchConfiguration {
        const envConfigs: ICppEnvConfig[] = [];
        for (const key in request.env) {
            if (request.env.hasOwnProperty(key)) {
                envConfigs.push({
                    name: key,
                    value: request.env[key],
                });
            }
        }

        if (os.platform() === "win32") {
            const type = request.debugger? request.debugger : "cppvsdbg";
            const cppvsdbgLaunchConfig: ICppvsdbgLaunchConfiguration = {
                name: request.nodeName,
                type: type,
                request: "launch",
                cwd: ".",
                program: request.executable,
                args: request.arguments,
                environment: envConfigs,
                stopAtEntry: stopOnEntry,
                symbolSearchPath: request.symbolSearchPath,
                sourceFileMap: request.sourceFileMap
            };

            return cppvsdbgLaunchConfig;
        } else {
            const type = request.debugger? request.debugger : "cppdbg";
            const cwd = request.cwd? request.cwd : ".";
            const cppdbgLaunchConfig: ICppdbgLaunchConfiguration = {
                name: request.nodeName,
                type: type,
                request: "launch",
                cwd: cwd,
                program: request.executable,
                args: request.arguments,
                environment: envConfigs,
                stopAtEntry: stopOnEntry,
                additionalSOLibSearchPath: request.additionalSOLibSearchPath,
                sourceFileMap: request.sourceFileMap,
                externalConsole:true,
                setupCommands: [
                    {
                        text: "-enable-pretty-printing",
                        description: "Enable pretty-printing for gdb",
                        ignoreFailures: true
                    }
                ]
            };
            
            return cppdbgLaunchConfig;
        }
    }

    private async executeLaunchRequest(request: ILaunchRequest, stopOnEntry: boolean) {
        let debugConfig: ICppvsdbgLaunchConfiguration | ICppdbgLaunchConfiguration | IPythonLaunchConfiguration;

        if (os.platform() === "win32") {
            let nodePath = path.parse(request.executable);

            if (nodePath.ext.toLowerCase() === ".exe") {

                // On Windows, colcon will compile Python scripts, C# and Rust programs to .exe. 
                // Discriminate between different runtimes by introspection.

                // Python
                // rosnode.py will be compiled into install\rosnode\Lib\rosnode\rosnode.exe
                // rosnode.py will also be copied into install\rosnode\Lib\site-packages\rosnode.py

                let pythonPath = path.join(nodePath.dir, "..", "site-packages", nodePath.name, nodePath.name + ".py");

                try {
                    await fsp.access(pythonPath, fs.constants.R_OK);

                    // If the python file is available, then treat it as python and fall through.
                    request.executable = pythonPath;
                    debugConfig = this.createPythonLaunchConfig(request, stopOnEntry);
                } catch {
                    // The python file is not available then this must be...

                    // C#? Todo

                    // Rust? Todo

                    // C++
                    debugConfig = this.createCppLaunchConfig(request, stopOnEntry);
                }
            } else if (nodePath.ext.toLowerCase() === ".py") {
                debugConfig = this.createPythonLaunchConfig(request, stopOnEntry);
            }

            if (!debugConfig) {
                throw (new Error(`Failed to create a debug configuration!`));
            }
            const launched = await vscode.debug.startDebugging(undefined, debugConfig);
            if (!launched) {
                throw (new Error(`Failed to start debug session!`));
            }
        } else {
            // this should be guaranteed by roslaunch
            await fsp.access(request.executable, fs.constants.X_OK | fs.constants.R_OK);

            const fileStream = fs.createReadStream(request.executable);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });

            // we only want to read 1 line to check for shebang line
            let linesToRead: number = 1;
            rl.on("line", async (line) => {
                if (linesToRead <= 0) {
                    return;
                }
                linesToRead--;
                if (!linesToRead) {
                    rl.close();
                }

                // look for Python in shebang line
                if (line.startsWith("#!") && line.toLowerCase().indexOf("python") !== -1) {
                    debugConfig = this.createPythonLaunchConfig(request, stopOnEntry);
                } else {
                    debugConfig = this.createCppLaunchConfig(request, stopOnEntry);
                }

                if (!debugConfig) {
                    throw (new Error(`Failed to create a debug configuration!`));
                }
                const launched = await vscode.debug.startDebugging(undefined, debugConfig);
                if (!launched) {
                    throw (new Error(`Failed to start debug session!`));
                }
            });
        }
    }
}
