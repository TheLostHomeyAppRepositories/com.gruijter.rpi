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

const { Device } = require('homey');

const util = require('util');
const RPI = require('../../lib/rpi_ssh');

const setTimeoutPromise = util.promisify(setTimeout);

class RPiDevice extends Device {

  async onInit() {
    try {
      // this.setUnavailable('Waiting for connection').catch(() => null);
      await this.destroyListeners();
      this.unloaded = false;
      this.busy = false;
      this.skipCounter = 0;
      this.watchDogCounter = 15;
      this.lastPollFastTm = 0;
      this.lastPollSlowTm = 0;
      this.lastHourlyPollTm = 0;
      this.settings = { ...this.getSettings() };
      await this.migrate().catch((err) => this.error(err));
      if (this.rpi) await this.rpi.connect();
      if (!this.rpi) this.rpi = new RPI(this.settings, this.log.bind(this));
      // start polling device for info
      const pollingInterval = this.settings.pollingInterval ? this.settings.pollingInterval : this.settings.pollingIntervalSlow; // minimum 1 second, maximum 5 seconds
      this.startPolling(pollingInterval).catch((err) => this.error(err));
      await this.registerListeners();
      this.log(`${this.getName()} has been initialized`);
    } catch (error) {
      this.error(error);
      // this.setUnavailable(error).catch(() => null);
      this.restartDevice(60 * 1000).catch((err) => this.error(err));
    }
  }

  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      // store the capability states before migration
      const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
      const state = this[sym];
      // check and repair incorrect capability(order)
      let capsChanged = false;
      const correctCaps = this.driver.ds.capabilities;
      for (let index = 0; index < correctCaps.length; index += 1) {
        const caps = this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          this.setUnavailable('Device is migrating. Please wait!').catch((err) => this.error(err));
          capsChanged = true;
          // remove all caps from here
          for (let i = index; i < caps.length; i += 1) {
            this.log(`removing capability ${caps[i]} for ${this.getName()}`);
            await this.removeCapability(caps[i])
              .catch((error) => this.log(error));
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
          // add the new cap
          this.log(`adding capability ${newCap} for ${this.getName()}`);
          await this.addCapability(newCap);
          // restore capability state
          if (state[newCap]) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
          // else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
          if (state[newCap] !== undefined) this.setCapability(newCap, state[newCap]).catch((err) => this.error(err));
          await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
        }
      }
      if (capsChanged) this.restartDevice(1 * 1000).catch((err) => this.error(err));
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    this.log('Device unInit', this.getName());
    this.unloaded = true;
    await this.stopPolling();
    await this.destroyListeners();
    // await setTimeoutPromise(5000); // wait 5 secs
  }

  async onAdded() {
    this.log(`${this.getName()} has been added`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // Create a copy to avoid modifying the actual settings object before logging.
    const settingsToLog = { ...newSettings };

    // Obfuscate sensitive data for logging.
    if (settingsToLog.privateKey && typeof settingsToLog.privateKey === 'string') {
      // Only show the header of the private key.
      settingsToLog.privateKey = `${settingsToLog.privateKey.substring(0, 29)}...`;
    }
    if (settingsToLog.password) {
      settingsToLog.password = '********';
    }
    this.log(`${this.getName()} settings where changed`, settingsToLog);
    this.restartDevice(3 * 1000).catch((err) => this.error(err));
  }

  async onDeleted() {
    this.log(`Device deleted: ${this.getName()}. Attempting to clean up SSH key on the remote host.`);
    await this.stopPolling(); // Stop any ongoing operations

    try {
      // Create a temporary RPI instance with the device's settings to connect one last time.
      const rpi = new RPI(this.getSettings(), this.log.bind(this));
      await rpi.connect();

      // The command to remove the specific key associated with this app.
      const cleanupCommand = "sed -i '/com.gruijter.rpi/d' ~/.ssh/authorized_keys";
      this.log(`Executing cleanup command on ${this.getSetting('host')}: ${cleanupCommand}`);
      await rpi.execute(cleanupCommand);

      await rpi.disconnect();
      this.log('Successfully removed public key from the remote host.');
    } catch (error) {
      // It's common for this to fail if the RPi is offline.
      // We log it but don't throw, as we don't want to prevent the device from being deleted in Homey.
      this.error(`Could not clean up public key on ${this.getSetting('host')}. This is not critical and may happen if the device was offline. Error: ${error.message}`);
    }

    await this.destroyListeners();
    this.log('Device cleanup complete.', this.getName());
  }

  async startPolling(interval) {
    this.homey.clearInterval(this.intervalIdPoll);
    this.log(`start polling ${this.getName()} @${interval} seconds interval`);
    await this.doPoll().catch((err) => this.error(err));
    this.intervalIdPoll = this.homey.setInterval(() => {
      this.doPoll().catch((err) => this.error(err));
    }, 1000); // interval * 1000); > try every second
  }

  async stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    this.homey.clearInterval(this.intervalIdPoll);
  }

  async restartDevice(delay) {
    try {
      if (this.restarting) return;
      this.restarting = true;
      await this.stopPolling();
      // this.destroyListeners();
      const dly = delay || 2000;
      this.log(`Device will restart in ${dly / 1000} seconds`);
      // await this.setUnavailable('Device is restarting. Wait a few minutes!');
      await setTimeoutPromise(dly);
      if (this.unloaded) {
        this.log('Device was uninitialized during restart delay. Aborting restart.');
        return;
      }
      this.restarting = false;
      this.onInit().catch((err) => this.error(err));
    } catch (error) {
      this.error(error);
    }
  }

  async doPoll() {
    try {
      if (this.watchDogCounter <= 0) {
        this.log('watchdog triggered, restarting Homey device now');
        this.setUnavailable(this.homey.__('device.connectionError')).catch(() => null);
        this.restartDevice(60 * 1000).catch((err) => this.error(err));
        return;
      }
      // check if any poll needs to be done this second
      const now = Date.now();
      // Default to true if the setting is not present (for backward compatibility with existing devices)
      const monitorGpioEnabled = this.settings.monitorGpio !== false;
      const doFastPoll = monitorGpioEnabled && this.settings.pollingInterval > 0 && ((now - this.lastPollFastTm) >= (this.settings.pollingInterval * 1000));
      const doSlowPoll = (now - this.lastPollSlowTm) >= (this.settings.pollingIntervalSlow * 1000);
      const doHourlyPoll = (now - this.lastHourlyPollTm) > 1000 * 60 * 60;
      if (!doFastPoll && !doSlowPoll) return;
      if (this.busy) {
        this.watchDogCounter -= 1;
        this.skipCounter += 1;
        if (this.skipCounter > 1) this.log(`${this.getName()} skipping multiple polls`, this.skipCounter, this.watchDogCounter);
        return;
      }
      this.busy = true;
      this.skipCounter = 0;
      if (doSlowPoll) {
        // get new status and update the devicestate
        const stats = await this.rpi.getStats();
        await this.updateDeviceState(stats);
        // Get user log from stats (already fetched) and trigger flow
        if (stats && stats.lastLogins) {
          await this.updateLogTrigger(stats.lastLogins);
        }
        this.lastPollSlowTm = now;
      }
      if (doFastPoll) { // This block is now skipped if monitorGpio is false or interval is 0
        const gpio = await this.rpi.getGPIOStates();
        await this.updateGpioState(gpio);
        this.lastPollFastTm = now;
      }
      if (doHourlyPoll) {
        const sysInfo = await this.rpi.getSysInfo();
        await this.updateSysInfo(sysInfo);
        this.lastHourlyPollTm = now;
      }
      this.setAvailable().catch(() => null);
      this.watchDogCounter = 15;
      this.busy = false;
    } catch (error) {
      this.watchDogCounter -= 1;
      this.busy = false;
      this.error('Poll error', error.message);
    }
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      await this.setCapabilityValue(capability, value)
        .catch((error) => {
          this.log(error, capability, value);
        });
    }
  }

  calculateSpeed(newstats, oldstats) {
    try {
      if (!oldstats) return {};
      // calculate speeds
      const deltaTime = (newstats.timestamp - oldstats.timestamp); // milliseconds
      if (deltaTime <= 0) return {}; // Prevent division by zero
      let dseth = Math.round((8 * (newstats.ETH0Traffic.rxBytes - oldstats.ETH0Traffic.rxBytes)) / deltaTime) / 1000;
      let useth = Math.round((8 * (newstats.ETH0Traffic.txBytes - oldstats.ETH0Traffic.txBytes)) / deltaTime) / 1000;
      let dswlan = Math.round((8 * (newstats.WLAN0Traffic.rxBytes - oldstats.WLAN0Traffic.rxBytes)) / deltaTime) / 1000;
      let uswlan = Math.round((8 * (newstats.WLAN0Traffic.txBytes - oldstats.WLAN0Traffic.txBytes)) / deltaTime) / 1000;
      dseth = dseth < 0 ? 0 : dseth;
      useth = useth < 0 ? 0 : useth;
      dswlan = dswlan < 0 ? 0 : dswlan;
      uswlan = uswlan < 0 ? 0 : uswlan;
      return {
        dseth, useth, dswlan, uswlan,
      };
    } catch (error) {
      this.error(error);
      return {};
    }
  }

  async updateSysInfo(sysInfo) {
    const currentSettings = { ...this.getSettings() };
    const newSysInfo = Object.fromEntries(
      Object.entries(sysInfo)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    let sysInfoChanged = false;
    Object.entries(newSysInfo).forEach((entry) => {
      if (currentSettings[entry[0]] && (currentSettings[entry[0]] !== entry[1])) {
        this.log(`${this.getName()} updating sysInfo`, entry[0], entry[1]);
        sysInfoChanged = true;
      }
    });
    if (sysInfoChanged) this.setSettings(newSysInfo).catch((err) => this.error(err));
  }

  async updateGpioState(gpio) {
    try {
      // add GPIO capability states for first 16 GPIO
      const capabilityStates = {};
      for (const [key, value] of Object.entries(gpio)) {
        if (Number(key) < 16) {
          capabilityStates[`onoff.gpio${key}`] = value.level;
          capabilityStates[`button.gpio${key}`] = value.func === 'OUTPUT';
        }
      }
      // set the capabilities
      Object.entries(capabilityStates).forEach((entry) => {
        this.setCapability(entry[0], entry[1]).catch((err) => this.error(err));
      });
      // triggger GPIO flows on change
      if (this.lastGpio) {
        for (const [key, value] of Object.entries(gpio)) {
          if (value && this.lastGpio[key] && (value.level !== this.lastGpio[key].level)) {
            const drive = value.level ? 'dh' : 'dl';
            const state = { io: Number(key) };
            // console.log(`${this.getName()} GPIO${key} changed to ${drive}`);
            if (drive === 'dh') {
              this.homey.app.triggerGpioHigh(this, {}, state);
            } else {
              this.homey.app.triggerGpioLow(this, {}, state);
            }
          }
        }
      }
      // save last GPIO states
      this.lastGpio = { ...gpio };
    } catch (error) {
      this.error(error);
    }
  }

  async updateDeviceState(stats) {
    try {
      // calculate network speeds
      const speeds = this.calculateSpeed(stats, this.lastStats);
      const capabilityStates = {
        'measure_temperature.gpu': stats.gpuTemp,
        'measure_temperature.cpu': stats.cpuTemp,
        meter_cpu_utilization: stats.cpuUsage,
        meter_cpu_scaling: stats.cpuScaling,
        meter_mem_utilization: stats.memUsage,
        meter_storage_utilization: stats.storageUsage,
        'meter_processes.active': stats.activeProcesses,
        'meter_processes.running': stats.runningProcesses,
        uptime: stats.uptime,
        meter_users: stats.users,
        'meter_download_speed.eth0': speeds.dseth,
        'meter_upload_speed.eth0': speeds.useth,
        'meter_download_speed.wlan0': speeds.dswlan,
        'meter_upload_speed.wlan0': speeds.uswlan,
      };
      // set the capabilities
      Object.entries(capabilityStates).forEach((entry) => {
        this.setCapability(entry[0], entry[1]).catch((err) => this.error(err));
      });
      // save last stats
      this.lastStats = { ...stats };
    } catch (error) {
      this.error(error);
    }
  }

  // trigger flows
  async updateLogTrigger(newLogs) {
    try {
      const { newUsers, goneUsers } = await this.rpi.findLogsDelta(newLogs);
      newUsers.forEach((user) => {
        // trigger new user card
        this.log('user login:', user);
        this.homey.app.triggerUserLogin(this, user);
      });
      goneUsers.forEach((user) => {
        // trigger gone user card
        this.log('user logout:', user);
        this.homey.app.triggerUserLogout(this, user);
      });
    } catch (error) {
      this.error(error);
    }
  }

  // condition flow card helpers
  async gpioIsHigh(args) {
    if (!this.lastGpio || !this.lastGpio[args.io]) throw Error('GPIO state unkown');
    return this.lastGpio[args.io].level;
  }

  // commands to rpi
  async executeCommand(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} Executing ${args.command} by ${source}`);
      const resp = await this.rpi.execute(args.command);
      const tokens = { response: JSON.stringify(resp) };
      return tokens;
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async setGpioOutput(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      if (!this.lastGpio) {
        const gpio = await this.rpi.getGPIOStates();
        await this.updateGpioState(gpio);
      }
      if (this?.lastGpio[args.io]?.func !== 'OUTPUT') throw Error(`GPIO${args.io} is not set as OUTPUT`);
      this.log(`${this.getName()} Setting GPIO${args.io} to ${args.high} by ${source}`);
      await this.rpi.setGPIOState(args); // { io: 5, high: true }
      return true;
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async setGpioFunction(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} Setting GPIO${args.io} to OUTPUT ${args.output} by ${source}`);
      await this.rpi.setGPIOFunction(args); // { io: 5, output: true }
      return true;
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async update(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} update command sent by ${source}`);
      await this.rpi.update();
      return true;
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async reboot(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} reboot command sent by ${source}`);
      await this.rpi.reboot();
      return true;
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async poweroff(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} poweroff command sent by ${source}`);
      await this.rpi.poweroff();
      return true;
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  // Docker flow stuff
  async getContainers(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      if (source === 'flow') this.log(`${this.getName()} listing Docker containers by ${source}`);
      const containers = await this.rpi.getContainers();
      return Promise.resolve(containers);
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async stopContainer(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} stop Docker container ${args.id.name} from ${source}`);
      await this.rpi.stopContainer(args.id.name);
      return Promise.resolve(true);
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async startContainer(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} start Docker container ${args.id.name} from ${source}`);
      await this.rpi.startContainer(args.id.name);
      return Promise.resolve(true);
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  async restartContainer(args, source) {
    try {
      if (!this.rpi) throw Error('Rpi not ready');
      this.log(`${this.getName()} restart Docker container ${args.id.name} from ${source}`);
      await this.rpi.restartContainer(args.id.name);
      return Promise.resolve(true);
    } catch (error) {
      this.error(`${this.getName()}`, error && error.message);
      return Promise.reject(error);
    }
  }

  // homey device listeners
  async registerListeners() {
    if (this.listenersSet) return;
    // GPIO button onoff listener
    for (let idx = 0; idx < 16; idx++) {
      this.registerCapabilityListener(`onoff.gpio${idx}`, async (value) => {
        await this.setGpioOutput({ io: idx, high: value }, 'user app');
      });
      this.registerCapabilityListener(`button.gpio${idx}`, async (value) => {
        await this.setGpioFunction({ io: idx, output: value }, 'user app');
      });
    }
    this.listenersSet = true;
    this.log(`${this.getName()} ready setting up listeners`);
  }

  // remove listeners NEEDS TO BE ADAPTED
  async destroyListeners() {
    try {
      this.log('removing listeners', this.getName());
      if (this.rpi) await this.rpi.disconnect();
      // this.homey.removeAllListeners('......');
    } catch (error) {
      this.error(error);
    }
  }

}

module.exports = RPiDevice;
