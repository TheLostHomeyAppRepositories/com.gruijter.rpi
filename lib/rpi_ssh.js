/*
Copyright 2024 -2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.rpi.

com.gruijter.rpi is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.rpi is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.rpi. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const { NodeSSH } = require('node-ssh');

// const util = require('util');

// const setTimeoutPromise = util.promisify(setTimeout);

const defaultPort = 22;
const defaultTimeout = 10000;

// used for system info
const getCPUInfo = 'cat /proc/cpuinfo'; // Raspberry Pi 4 Model B Rev 1.1
const getOSInfo = 'cat /etc/os-release'; // Debian GNU/Linux 12 (bookworm)
const getOSArch = 'uname -m'; // 'aarch64'
const getHostName = 'uname -n'; // 'rpi4'

// used for stats
const getUptime = 'uptime'; // '14:03:55 up 58 min,  2 users,  load average: 0.17, 0.14, 0.15'
const getBootDate = 'uptime -s'; // '2024-08-03 13:05:26'
const getNetDevInfo = 'cat /proc/net/dev';
const getGPUTemp = 'vcgencmd measure_temp'; // "temp=50.1'C"
const getCPUTemp = 'cat /sys/class/thermal/thermal_zone0/temp'; // '51608' => need to divide by 1000
const getCPUCurFreq = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'; // 600000
const getCPUMaxFreq = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq'; // 1500000
const getMemoryStats = 'cat /proc/meminfo';
const getRootStorageInfo = 'df /';
const getProcesses = 'ps -eo state --no-headers';
const getVmstat = 'vmstat 1 2';

// used for user sessions
const getUsers = 'w';
const getLastLogin = 'last -10 --time-format iso'; // get last logged in/out users

// used for OS commands
const reboot = 'sudo systemctl reboot';
const poweroff = 'sudo systemctl poweroff';
const update = 'sudo apt-get update && sudo apt-get upgrade -y';

// used for GPIO
const getGPIOStates = 'raspi-gpio get';
const setGPIOState = 'raspi-gpio set';
const getGPIOStatesNew = 'pinctrl get';
const setGPIOStateNew = 'pinctrl set';

// used for docker
const getContainers = 'sudo docker ps -a';
const stopContainer = 'sudo docker stop '; // add container name or id
const startContainer = 'sudo docker start '; // add container name or id
const restartContainer = 'sudo docker restart '; // add container name or id

// Represents a SSH session to a remote server.
class RPi {

  constructor(opts, logger) {
    const options = opts || {};
    // eslint-disable-next-line no-console
    this.log = logger || console.log;
    this.username = options.username;
    this.password = options.password;
    this.privateKey = options.privateKey;
    this.host = options.host;
    this.port = options.port || defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.sshClient = new NodeSSH(); // Create a new SSH client instance
    this.connected = false;
    this.lastResponse = undefined;
    this.connectPromise = null;
    // process.on('warning', e => console.warn(e.stack));
  }

  async connect(opts) {
    try {
      const options = opts || {};
      const host = options.host || this.host;
      const port = options.port || this.port;
      const username = options.username || this.username;
      const password = options.password || this.password;
      const privateKey = options.privateKey || this.privateKey;
      const timeout = options.timeout || this.timeout;
      this.host = host;
      this.port = port;
      this.username = username;
      this.password = password;
      this.privateKey = privateKey;
      this.timeout = timeout;
      // Connect to the SSH server
      const connectionParams = {
        host,
        port,
        readyTimeout: defaultTimeout,
        timeout: defaultTimeout,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        username,
        // debug: (d) => console.log(d),
      };
      if (password) {
        this.log(`[rpi-ssh] Connecting to ${host} using username/password.`);
        connectionParams.password = password;
      } else if (privateKey) {
        this.log(`[rpi-ssh] Connecting to ${host} using SSH key.`);
        connectionParams.privateKey = privateKey;
      } else {
        throw new Error('No authentication method provided (password or privateKey).');
      }
      await this.disconnect();
      if (!this.sshClient) this.sshClient = new NodeSSH();
      await this.sshClient.connect(connectionParams);

      // Suppress background socket errors so they don't crash the Homey app
      if (this.sshClient.connection) {
        this.sshClient.connection.on('error', (err) => {
          this.connected = false;
          this.log(`[rpi-ssh] Caught background socket error for ${this.host}: ${err.message}. Crash prevented.`);
        });
      }

      this.connected = true;
      return true;
    } catch (error) {
      // console.log('failed to connect', error);
      this.connected = false;
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect() {
    if (this.sshClient) {
      this.sshClient.dispose();
      this.sshClient = null;
    }
    this.connected = false;
  }

  // Execute a command on the remote server
  async execute(command) {
    if (!this.connected || !this.sshClient || !this.sshClient.isConnected()) {
      if (this.connectPromise === null) {
        this.connectPromise = this.connect();
      }
      await this.connectPromise;
    }
    const result = await this.sshClient.execCommand(command);
    this.lastResponse = result;
    if (result.code !== 0) throw Error(result.stderr + result.stdout);
    return result.stdout;
  }

  // Execute a command on the remote server without error return, except connection errors
  async silentExec(command) {
    try {
      const result = await this.execute(command);
      return result;
    } catch (error) {
      if (!this.connected) throw error;
      return null;
    }
  }

  // get host system info
  async getSysInfo() {
    const [
      hostName,
      osArch,
      cpuInfo,
      cpuMaxFreq,
      osInfo,
    ] = await Promise.all([
      this.silentExec(getHostName),
      this.silentExec(getOSArch),
      this.silentExec(getCPUInfo),
      this.silentExec(getCPUMaxFreq),
      this.silentExec(getOSInfo),
    ]);

    let processors;
    let revision;
    let serial;
    let model;
    if (cpuInfo) {
      processors = (cpuInfo.match(/processor\s+:/g) || []).length;
      const revisionMatch = cpuInfo.match(/Revision\s+:\s+([^\n]+)/);
      revision = revisionMatch ? revisionMatch[1].trim() : null;
      const serialMatch = cpuInfo.match(/Serial\s+:\s+([^\n]+)/);
      serial = serialMatch ? serialMatch[1].trim() : null;
      const modelMatch = cpuInfo.match(/Model\s+:\s+([^\n]+)/);
      model = modelMatch ? modelMatch[1].trim() : null;
    }

    let osName;
    let osVersion;
    if (osInfo) {
      const nameMatch = osInfo.match(/^NAME="([^"]+)"/m);
      osName = nameMatch ? nameMatch[1].trim() : null;
      const versionMatch = osInfo.match(/VERSION="([^"]+)"/);
      osVersion = versionMatch ? versionMatch[1].trim() : null;
    }

    const sysInfo = {
      hostName,
      model,
      revision,
      serial,
      processors,
      cpuMaxFreq,
      osArch,
      osName,
      osVersion,
    };
    this.sysInfo = sysInfo;
    return sysInfo;
  }

  // helper to find lastLogin delta
  findLogsDelta(newLogs, oldLogsXXX) {
    if (!newLogs) throw Error('newLogs missing');
    const { oldLogs } = this;
    let newUsers = [];
    let goneUsers = [];
    if (!oldLogs) {
      this.oldLogs = [...newLogs];
      return { newUsers, goneUsers };
    }
    // find new logins
    const newLoggedInNow = newLogs.filter((logNew) => !logNew.logoutTime && !logNew.info.includes('gone')); // still logged in
    let oldLoggedInNow = oldLogs.filter((logOld) => !logOld.logoutTime && !logOld.info.includes('gone')); // still logged in

    newUsers = newLoggedInNow.filter((newLog) => {
      const match = oldLoggedInNow.find((oldLog) => oldLog.loginTime === newLog.loginTime);
      return !match;
    });

    if (newUsers.length) {
      oldLoggedInNow = oldLogs.slice(0, -newUsers.length).filter((logOld) => !logOld.logoutTime && !logOld.info.includes('gone'));
    }

    goneUsers = oldLoggedInNow
      .filter((oldLog) => {
        const match = newLoggedInNow.find((newLog) => oldLog.loginTime === newLog.loginTime);
        return !match;
      })
      .map((oldLog) => {
        let goneLog = newLogs.find((newLog) => oldLog.loginTime === newLog.loginTime);
        if (!goneLog) goneLog = oldLog;
        return goneLog;
      });

    this.oldLogs = [...newLogs];
    return { newUsers, goneUsers };
  }

  // get last Login/Out
  async getLastLogin() {
    let lastLogin = [];
    const lastLoginRaw = await this.silentExec(getLastLogin);
    if (lastLoginRaw) {
      const parseLine = (line) => {
        // eslint-disable-next-line max-len
        const regex = /(\w+)\s+(pts\/\d+|\s{3,})\s+(\d+\.\d+\.\d+\.\d+|\s{3,})\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{2}:\d{2})(?:\s+-\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{2}:\d{2})\s+\((\d{2}:\d{2})\))?(.*)/;
        const match = line.match(regex);
        if (!match) return null;
        return {
          user: match[1].trim(),
          tty: match[2].trim() || '',
          host: match[3].trim() || '',
          loginTime: match[4],
          logoutTime: match[5] || '',
          duration: match[6] || '',
          info: match[7].trim(),
        };
      };
      const lines = lastLoginRaw.split('\n');
      lastLogin = lines.map(parseLine).filter(Boolean);
    }
    return lastLogin;
  }

  // get active user sessions
  async getUsers() {
    let userArray = [];
    const userInfo = await this.silentExec(getUsers);
    if (userInfo) {
      const lines = userInfo.trim().split('\n');
      const headerLineIndex = lines.findIndex((line) => line.startsWith('USER'));
      const headerLineItems = lines[headerLineIndex].trim().replace('@', '').split(/\s+/);
      const userLines = lines.slice(headerLineIndex + 1);
      userArray = userLines.map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < headerLineItems.length) parts.splice(1, 0, '-');
        const user = {};
        headerLineItems.forEach((header, idx) => {
          user[header] = parts[idx];
        });
        return user;
      });
    }
    return userArray;
  }

  // get various realtime statistics
  async getStats() {
    if (!this.sysInfo) await this.getSysInfo();

    // 1. Fetch uptime sequentially to get an accurate user count, as parallel execs can inflate this.
    const uptimeRaw = await this.silentExec(getUptime);

    // 2. Fetch non-load-sensitive data in parallel batches to maintain speed without overwhelming the RPi.
    const parallelCommandMap = {
      bootDateRaw: getBootDate,
      lastLoginRaw: getLastLogin,
      cpuTempRaw: getCPUTemp,
      gpuTempRaw: getGPUTemp,
      cpuCurFreq: getCPUCurFreq,
      rootStorageInfo: getRootStorageInfo,
      netDevInfo: getNetDevInfo,
    };

    const parallelCommandKeys = Object.keys(parallelCommandMap);
    const rawResults = {};
    const batchSize = 4; // Execute 4 commands at a time to balance speed and system load.

    for (let i = 0; i < parallelCommandKeys.length; i += batchSize) {
      const batchKeys = parallelCommandKeys.slice(i, i + batchSize);
      const batchPromises = batchKeys.map((key) => this.silentExec(parallelCommandMap[key]));
      const batchResults = await Promise.all(batchPromises);
      batchKeys.forEach((key, index) => {
        rawResults[key] = batchResults[index];
      });
    }

    // 3. Fetch load-sensitive data sequentially AFTER the parallel batches are complete.
    // This provides a more accurate baseline reading of the system's state, avoiding the "observer effect"
    // where the polling itself inflates CPU, memory, and process counts.
    rawResults.memstat = await this.silentExec(getMemoryStats);
    rawResults.processes = await this.silentExec(getProcesses);
    rawResults.vmstat = await this.silentExec(getVmstat);

    const {
      bootDateRaw,
      lastLoginRaw,
      cpuTempRaw,
      gpuTempRaw,
      cpuCurFreq,
      rootStorageInfo,
      netDevInfo,
      memstat,
      processes,
      vmstat,
    } = rawResults;

    const bootDate = bootDateRaw ? new Date(bootDateRaw) : null;

    let uptime;
    let users;
    let loadAvg; // The 1-minute load average.
    if (uptimeRaw) {
      const match = uptimeRaw.match(/up\s+((\d+\s+days?,\s+)?(\d+:\d+|\d+\s+min)),\s+(\d+)\s+users?,\s+load\s+average:\s+(\d+\.\d+)/);
      if (match) {
        uptime = match[1].trim();
        users = parseInt(match[4], 10);
        loadAvg = parseFloat(match[5]);
      }
    }

    let cpuUsage;
    let runningProcesses;
    if (vmstat) {
      const lines = vmstat.trim().split('\n');
      if (lines.length > 2) { // Ensure we have the data line from the second interval
        const cpuLine = lines.pop().trim().split(/\s+/);
        const idle = parseFloat(cpuLine[14]);
        if (!Number.isNaN(idle)) cpuUsage = Math.max(0, Math.min(100, Math.round(100 - idle)));
        const rProcs = parseInt(cpuLine[0], 10);
        if (!Number.isNaN(rProcs)) runningProcesses = rProcs;
      }
    }

    let lastLogins = [];
    if (lastLoginRaw) lastLogins = lastLoginRaw;

    const cpuTemp = cpuTempRaw ? cpuTempRaw / 1000 : null;

    let gpuTemp = null;
    if (gpuTempRaw) {
      const match = gpuTempRaw.match(/[-+]?\d*\.?\d+/);
      if (match) gpuTemp = Number(match[0]);
    }

    const { cpuMaxFreq } = this.sysInfo;
    let cpuScaling;
    if (cpuCurFreq && cpuMaxFreq) cpuScaling = Math.round(100 * (Number(cpuCurFreq) / Number(cpuMaxFreq)));

    let memUsage;
    if (memstat) {
      const totalMatch = memstat.match(/MemTotal:\s+(\d+)/);
      const availMatch = memstat.match(/MemAvailable:\s+(\d+)/);
      if (totalMatch) {
        const totalMemory = parseInt(totalMatch[1], 10);
        if (availMatch) {
          const availableMemory = parseInt(availMatch[1], 10);
          if (totalMemory > 0) memUsage = Math.round(100 - (availableMemory / totalMemory) * 100);
        } else {
          // Fallback for older Linux kernels missing MemAvailable
          const freeMatch = memstat.match(/MemFree:\s+(\d+)/);
          const buffersMatch = memstat.match(/Buffers:\s+(\d+)/);
          const cachedMatch = memstat.match(/Cached:\s+(\d+)/);
          if (freeMatch && buffersMatch && cachedMatch) {
            const availableMemory = parseInt(freeMatch[1], 10) + parseInt(buffersMatch[1], 10) + parseInt(cachedMatch[1], 10);
            if (totalMemory > 0) memUsage = Math.round(100 - (availableMemory / totalMemory) * 100);
          }
        }
      }
    }

    let storageUsage;
    if (rootStorageInfo) {
      const dataLine = rootStorageInfo.trim().split('\n')[1].trim().split(/\s+/);
      storageUsage = parseInt(dataLine[4].replace('%', ''), 10);
    }

    let totalProcesses;
    let activeProcesses;
    // runningProcesses is now sourced from the more efficient vmstat command
    if (processes) {
      const lines = processes.trim().split('\n').filter(Boolean);
      totalProcesses = lines.length;
      activeProcesses = 0;
      lines.forEach((stat) => {
        const s = stat.trim()[0];
        // 'R' (running/runnable) and 'S' (interruptible sleep) are considered active.
        if (s === 'R' || s === 'S') {
          activeProcesses += 1;
        }
      });
    }

    const WLAN0Traffic = { rxBytes: 0, txBytes: 0 };
    const ETH0Traffic = { rxBytes: 0, txBytes: 0 };
    if (netDevInfo) {
      const lines = netDevInfo.split('\n');
      lines.forEach((line) => {
        // Splitting by ':' first prevents bugs where huge byte counts merge into the interface name
        if (line.includes('wlan0:')) {
          const data = line.split(':')[1].trim().split(/\s+/);
          WLAN0Traffic.rxBytes = parseInt(data[0], 10) || 0;
          WLAN0Traffic.txBytes = parseInt(data[8], 10) || 0; // 9th column is TX bytes
        } else if (line.includes('eth0:')) {
          const data = line.split(':')[1].trim().split(/\s+/);
          ETH0Traffic.rxBytes = parseInt(data[0], 10) || 0;
          ETH0Traffic.txBytes = parseInt(data[8], 10) || 0;
        }
      });
    }

    const timestamp = new Date();

    const stats = {
      bootDate,
      uptime,
      users,
      lastLogins,
      loadAvg,
      gpuTemp,
      cpuTemp,
      cpuUsage,
      cpuScaling,
      memUsage,
      storageUsage,
      totalProcesses,
      activeProcesses,
      runningProcesses,
      ETH0Traffic,
      WLAN0Traffic,
      timestamp,
    };
    return stats;
  }

  async getGPIOStates() {
    const gpioStates = {};
    let raw = await this.silentExec(getGPIOStatesNew).catch(() => null);
    if (raw) {
      // Parse new format: "0: ip    pu | hi // ID_SDA/GPIO0 = input" or "0: op -- pu | lo // GPIO0 = output"
      const regex = /(\d+): (\w+)(?:\s+--)?(?:\s+d[hl])?\s+p([und])\s+\|\s+(hi|lo)/g;
      Array.from(raw.matchAll(regex)).forEach((match) => {
        const [, num, mode, pullStr, levelStr] = match;
        const gpio = parseInt(num, 10);
        let func;
        if (mode === 'ip') func = 'INPUT';
        else if (mode === 'op') func = 'OUTPUT';
        else if (mode.startsWith('a')) func = 'ALT';
        let alt = null;
        if (func === 'ALT') alt = parseInt(mode.substring(1), 10);
        const pull = { u: 'UP', d: 'DOWN', n: 'NONE' }[pullStr];
        gpioStates[gpio] = {
          level: levelStr === 'hi',
          func,
          alt,
          pull,
        };
      });
    } else {
      // Parse old format: "GPIO XX: level=X [func=XXX] [alt=X] [pull=XXX]"
      raw = await this.silentExec(getGPIOStates);
      if (!raw) return gpioStates;
      const regex = /GPIO\s*(\d+):\s*level=(\d)(?:\s*func=(\w+))?(?:\s*alt=(\d+))?(?:\s*pull=(\w+))?/g;
      Array.from(raw.matchAll(regex)).forEach((match) => {
        const [, num, level, func, alt, pull] = match;
        gpioStates[parseInt(num, 10)] = {
          level: level === '1',
          func: func || null,
          alt: alt ? parseInt(alt, 10) : null,
          pull: pull || null,
        };
      });
    }
    return gpioStates;
  }

  async update() {
    await this.execute(update);
    return true;
  }

  async poweroff() {
    await this.execute(poweroff);
    return true;
  }

  async reboot() {
    await this.execute(reboot);
    return true;
  }

  // set a GPIO output { io: number , high: boolean}
  async setGPIOState(set) {
    const drive = set.high ? 'dh' : 'dl';
    const executed = await this.execute(`${setGPIOStateNew} ${set.io} ${drive}`)
      .then(() => true)
      .catch(() => null);
    if (!executed) await this.execute(`${setGPIOState} ${set.io} ${drive}`);
    return true;
  }

  // set a GPIO output { io: number , output: boolean}
  async setGPIOFunction(set) {
    const func = set.output ? 'op' : 'ip';
    const executed = await this.execute(`${setGPIOStateNew} ${set.io} ${func}`)
      .then(() => true)
      .catch(() => null);
    if (!executed) await this.execute(`${setGPIOState} ${set.io} ${func}`);
    return true;
  }

  // docker get containerInfo
  async getContainers() {
    let containerInfo = [];
    const infoRaw = await this.silentExec(getContainers);
    if (infoRaw) {
      const lines = infoRaw.trim().split('\n');
      const headerLine = lines[0];

      // Identify the starting index of each column header
      const headers = [];
      const headerRegex = /[A-Z ]+(?=\s{2,}|$)/g;
      for (const match of headerLine.matchAll(headerRegex)) {
        headers.push({ name: match[0].trim(), start: match.index });
      }
      if (headers.length === 0) return [];

      containerInfo = lines.slice(1).map((line) => {
        return headers.reduce((obj, header, index) => {
          const end = headers[index + 1] ? headers[index + 1].start : line.length;
          obj[header.name] = line.substring(header.start, end).trim();
          return obj;
        }, {});
      });
    }
    return containerInfo;
  }

  // docker stop container
  async stopContainer(id) {
    await this.execute(stopContainer + id);
    return true;
  }

  // docker start container
  async startContainer(id) {
    await this.execute(startContainer + id);
    return true;
  }

  // docker restart container
  async restartContainer(id) {
    await this.execute(restartContainer + id);
    return true;
  }

}

module.exports = RPi;

/*
sysInfo:
{
  hostName: 'rpi4',
  model: 'Raspberry Pi 4 Model B Rev 1.1',
  revision: 'b03111',
  serial: '1000000003a833d2',
  processors: 4,
  cpuMaxFreq: '1500000',
  osArch: 'aarch64',
  osName: 'Debian GNU/Linux',
  osVersion: '12 (bookworm)'
}

getStats:
{
  bootDate: 2024-08-05T10:07:42.000Z,
  uptime: '1 day, 17 min',
  users: 1,
  loadAvg: 0.21,
  gpuTemp: 44.4,
  cpuTemp: 44.388,
  cpuUsage: 21,
  cpuScaling: 100,
  memUsage: 19,
  storageUsage: 8,
  totalProcesses: 78,
  activeProcesses: 48,
  runningProcesses: 1,
  ETH0Traffic: { rxBytes: 0, txBytes: 0 },
  WLAN0Traffic: { rxBytes: 51140057, txBytes: 112483994 },
  timestamp: 2024-08-06T11:25:06.926Z
}

getLastLogin:
[
  {
    user: 'pi',
    tty: null,
    host: null,
    loginTime: '2024-08-06T11:52:42+02:00',
    logoutTime: null,
    duration: null,
    info: 'still logged in'                    >> = 'LOGIN' VIA VNC (tty = null)
  },
  {
    user: 'pi',
    tty: null,
    host: null,
    loginTime: '2024-08-06T11:10:36+02:00',
    logoutTime: null,
    duration: null,
    info: 'gone - no logout'                    >> = 'LOGOUT' VIA VNC (tty = null)
  },
  {
    user: 'pi',
    tty: 'pts/1',
    host: '10.0.0.36',
    loginTime: '2024-08-06T10:58:14+02:00',
    logoutTime: '2024-08-06T11:06:24+02:00',    >> = LOGOUT VIA SSH (tty = 'pts/..')
    duration: '00:08',
    info: ''
  },
  {
    user: 'pi',
    tty: 'pts/0',
    host: '10.0.0.18',
    loginTime: '2024-08-06T10:52:20+02:00',
    logoutTime: null,
    duration: null,
    info: 'still logged in'                     >> = LOGIN VIA SSH (tty = 'pts/..')
  },
  {
    user: 'pi',
    tty: 'pts/0',
    host: '10.0.0.36',
    loginTime: '2024-08-05T22:13:46+02:00',
    logoutTime: '2024-08-05T22:14:00+02:00',
    duration: '00:00',
    info: ''
  },
  {
  user: 'pi',
  tty: null,
  host: null,
  loginTime: '2024-08-08T10:56:20+02:00',
  logoutTime: null,
  duration: null,
  info: '- down                       (03:49)'      >> = LOGOUT after reboot????
  },
]

getUsers:
[
  {
    USER: 'pi',
    TTY: '-',
    FROM: '-',
    LOGIN: '16:24',
    IDLE: '8:39m',
    JCPU: '6:07',
    PCPU: '2.11s',
    WHAT: '/usr/bin/wayfire'
  },
  {
    USER: 'pi',
    TTY: 'tty1',
    FROM: '-',
    LOGIN: 'Fri23',
    IDLE: '24:32m',
    JCPU: '0.09s',
    PCPU: '0.06s',
    WHAT: '-bash'
  },
  {
    USER: 'pi',
    TTY: 'pts/0',
    FROM: '10.0.0.18',
    LOGIN: '21:44',
    IDLE: '22:34',
    JCPU: '0.16s',
    PCPU: '0.16s',
    WHAT: '-bash'
  }
]

GPIO States:
{
  '0': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '1': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '2': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '3': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '4': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '5': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '6': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '7': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '8': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '9': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '10': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '11': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '12': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '13': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '14': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'NONE' },
  '15': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '16': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '17': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '18': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '19': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '20': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '21': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '22': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '23': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '24': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '25': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '26': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '27': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '28': { level: true, func: 'RGMII_MDIO', alt: 5, fsel: NaN, pull: 'UP' },
  '29': { level: false, func: 'RGMII_MDC', alt: 5, fsel: NaN, pull: 'DOWN' },
  '30': { level: false, func: 'CTS0', alt: 3, fsel: NaN, pull: 'UP' },
  '31': { level: false, func: 'RTS0', alt: 3, fsel: NaN, pull: 'NONE' },
  '32': { level: true, func: 'TXD0', alt: 3, fsel: NaN, pull: 'NONE' },
  '33': { level: true, func: 'RXD0', alt: 3, fsel: NaN, pull: 'UP' },
  '34': { level: true, func: 'SD1_CLK', alt: 3, fsel: NaN, pull: 'NONE' },
  '35': { level: true, func: 'SD1_CMD', alt: 3, fsel: NaN, pull: 'UP' },
  '36': { level: true, func: 'SD1_DAT0', alt: 3, fsel: NaN, pull: 'UP' },
  '37': { level: true, func: 'SD1_DAT1', alt: 3, fsel: NaN, pull: 'UP' },
  '38': { level: true, func: 'SD1_DAT2', alt: 3, fsel: NaN, pull: 'UP' },
  '39': { level: true, func: 'SD1_DAT3', alt: 3, fsel: NaN, pull: 'UP' },
  '40': { level: false, func: 'PWM1_0', alt: 0, fsel: NaN, pull: 'NONE' },
  '41': { level: false, func: 'PWM1_1', alt: 0, fsel: NaN, pull: 'NONE' },
  '42': { level: false, func: 'OUTPUT', alt: null, fsel: NaN, pull: 'UP' },
  '43': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '44': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '45': { level: true, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '46': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '47': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'UP' },
  '48': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '49': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '50': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '51': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '52': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' },
  '53': { level: false, func: 'INPUT', alt: null, fsel: NaN, pull: 'DOWN' }
}

getContainers:
[
  {
    'CONTAINER ID': 'b1a043344f3d',
    IMAGE: 'lscr.io/linuxserver/qbittorrent:latest',
    COMMAND: '"/init"',
    CREATED: '3 weeks ago',
    STATUS: 'Up 3 hours',
    PORTS: '0.0.0.0:6881->6881/tcp, :::6881->6881/tcp, 0.0.0.0:8888->8888/tcp, 0.0.0.0:6881->6881/udp, :::8888->8888/tcp, :::6881->6881/udp, 8080/tcp',
    NAMES: 'qbittorrent'
  },
  {
    'CONTAINER ID': '41a67e39a573',
    IMAGE: 'portainer/portainer-ce',
    COMMAND: '"/portainer"',
    CREATED: '3 weeks ago',
    STATUS: 'Up 3 hours',
    PORTS: '8000/tcp, 9443/tcp, 0.0.0.0:9000->9000/tcp, :::9000->9000/tcp',
    NAMES: 'portainer'
  }
]

*/
