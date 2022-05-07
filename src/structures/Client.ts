/** @format */

import * as Discord from "discord.js";
import type { MonkeyTypes } from "../types/types";
import { promisify } from "util";
import { resolve, join } from "path";
import { APIMessage } from "discord-api-types";
import globCB from "glob";
import { Worker } from "bullmq";
import { redis } from "../functions/redis";
import _ from "lodash";

interface PaginationOptions<T> {
  embedOptions: Discord.MessageEmbedOptions;
  interaction: Discord.CommandInteraction;
  amount: number;
  entries: T[];
  id: string;
  fieldName: string;
  send?: (
    embed: Discord.MessageEmbed,
    row: Discord.MessageActionRow,
    currentEntries: T[]
  ) => Promise<Discord.Message | APIMessage>;
  onPageChange?: (
    embed: Discord.MessageEmbed,
    currentEntries: T[]
  ) => Discord.MessageEmbed;
}

export class Client<T extends boolean> extends Discord.Client<T> {
  public static timeoutTime = 60000;
  public static iconURL =
    "https://pbs.twimg.com/profile_images/1430886941189230595/RS0odgx9_400x400.jpg";
  public static glob = promisify(globCB);
  public clientOptions: MonkeyTypes.ClientOptions;
  public commands = new Discord.Collection<string, MonkeyTypes.Command>();
  public tasks = new Discord.Collection<string, MonkeyTypes.TaskFile>();
  public categories = new Array<string>();
  public permissionsAdded = new Set<string>();

  constructor(options: MonkeyTypes.ClientOptions) {
    super(options);

    this.clientOptions = options;

    this.clientOptions.repoPath = join(
      process.cwd(),
      this.clientOptions.repoPath
    );
  }

  public initWorker(): void {
    const worker = new Worker<
      MonkeyTypes.Task,
      MonkeyTypes.TaskResult | undefined
    >(
      "george-tasks",
      async (job) => {
        const task = job.data;

        console.log(`Running task "${task.name}"`);

        const guild = await this.guild;

        if (guild === undefined) {
          console.error("Guild not found.");

          return;
        }

        const taskFile = this.tasks.get(task.name);

        if (taskFile === undefined) {
          console.error(`Task file for "${task.name}" not found.`);

          return;
        }

        try {
          const result = await taskFile.run(
            this as Client<true>,
            guild,
            ...task.args
          );

          return result;
        } catch (err) {
          console.log(err);
        }

        return;
      },
      {
        connection: redis(),
        concurrency: 1,
        runRetryDelay: 1000
      }
    );

    worker.on("completed", (job, result) => {
      if (result === undefined) {
        return;
      }

      const taskName = job.data.name;

      console.log(
        `Task ${taskName} finished ${
          result.status ? "successfully" : `with errors\n${result.message}`
        }.`
      );

      if (result.status) {
        console.log(`Task ${taskName} completed.`);
        console.log(result.message);
        this.logInBotLogChannel(result.message);
      } else {
        console.log(result.message);
        this.logInBotLogChannel(result.message);
      }
    });

    console.log(`Initialized task worker "${worker.name}"`);
  }

  public async start(token: string) {
    await this.login(token);

    const [commands, events] = await this.load();

    this.emit("ready", this as Client<true>);

    return `Loaded ${commands} commands and ${events} events`;
  }

  public async load(): Promise<[number, number]> {
    const commandFiles = await Client.glob(
      resolve(
        __dirname,
        "../",
        this.clientOptions.commandsPath,
        "**",
        "*.{ts,js}"
      )
    );

    const eventFiles = await Client.glob(
      resolve(
        __dirname,
        "../",
        this.clientOptions.eventsPath,
        "**",
        "*.{ts,js}"
      )
    );

    const taskFiles = await Client.glob(
      resolve(__dirname, "../", this.clientOptions.tasksPath, "**", "*.{ts,js}")
    );

    const commands = (await Promise.all(
      commandFiles.map(
        async (commandFilePath) =>
          (await import(commandFilePath)).default ||
          (await import(commandFilePath))
      )
    )) as MonkeyTypes.Command[];

    const events = (await Promise.all(
      eventFiles.map(
        async (eventFilePath) =>
          (await import(eventFilePath)).default || (await import(eventFilePath))
      )
    )) as MonkeyTypes.Event<keyof Discord.ClientEvents>[];

    events.forEach((event) =>
      this.on(event.event, event.run.bind(null, this as Client<true>))
    );

    const tasks = (await Promise.all(
      taskFiles.map(
        async (taskFilePath) =>
          (await import(taskFilePath)).default || (await import(taskFilePath))
      )
    )) as MonkeyTypes.TaskFile[];

    tasks.forEach((task) => this.tasks.set(task.name, task));

    // Handing slash commands

    const fetchOptions = {
      guildId: this.clientOptions.guildID,
      cache: true
    };

    const slashCommands = await this.application?.commands.fetch(fetchOptions);

    commands.forEach(async (command) => {
      this.commands.set(command.name, command);

      if (!this.categories.includes(command.category)) {
        this.categories.push(command.category);
      }

      const cmd = slashCommands?.find((c) => c.name === command.name);

      if (cmd === undefined) {
        const c = await this.application?.commands
          .create(
            {
              name: command.name,
              description: command.description,
              type: "CHAT_INPUT",
              options: command.options as Discord.ApplicationCommandOptionData[]
            },
            this.clientOptions.guildID
          )
          .catch(console.log);

        if (c === undefined) {
          console.log(`Error creating slash command "${command.name}"`);
        } else {
          console.log(`Created slash command "${c.name}" (${c.id})`);
        }
      } else {
        const mapper = (option: Discord.ApplicationCommandOption) => {
          type Keys = keyof typeof option;

          type Values = typeof option[Keys];

          type Entries = [Keys, Values];

          for (const [key, value] of Object.entries(option) as Entries[]) {
            if (
              value === undefined ||
              (_.isArray(value) && value.length === 0)
            ) {
              delete option[key];
            }
          }

          return option;
        };

        const cmdObject = {
          name: cmd.name,
          description: cmd.description,
          options: cmd.options.map(mapper)
        };

        const commandObject = {
          name: command.name,
          description: command.description,
          options: (command.options ?? []).map(mapper)
        };

        if (_.isEqual(cmdObject, commandObject)) {
          return;
        }

        await this.application?.commands.edit(
          cmd,
          {
            name: command.name,
            description: command.description,
            type: "CHAT_INPUT",
            options: command.options as Discord.ApplicationCommandOptionData[]
          },
          this.clientOptions.guildID
        );

        console.log(`Edited slash command "${cmd.name}" (${cmd.id})`);
      }
    });

    return [this.commands.size, events.length];
  }

  public embed(embedOptions: Discord.MessageEmbedOptions, user?: Discord.User) {
    // if (!embedOptions.title?.startsWith(this.user?.username ?? "George")) {
    // embedOptions.title = `${this.user?.username ?? "George"}: \`${
    //   embedOptions.title
    // }\``;
    // }

    embedOptions.footer = {
      text: "www.monkeytype.com",
      iconURL: Client.iconURL
    };

    if (embedOptions.author === undefined && user !== undefined) {
      embedOptions.author = {
        name: user.username,
        iconURL: user.avatarURL({ dynamic: true }) ?? ""
      };
    }

    const embed = new Discord.MessageEmbed(embedOptions);

    embed.setTimestamp();

    return embed;
  }

  public async paginate<T>(options: PaginationOptions<T>) {
    const {
      embedOptions,
      interaction,
      amount,
      entries,
      id,
      fieldName,
      send,
      onPageChange
    } = options;

    const maxPage =
      entries.length === 0 ? 1 : Math.ceil(entries.length / amount);

    let page = 0;

    if (embedOptions.fields === undefined) {
      embedOptions.fields = [];
    }

    const currentEntries = entries.slice(page * amount, page * amount + amount);

    embedOptions.fields.push({
      name: fieldName,
      value: currentEntries.join("\n") || "None"
    });

    let embed = this.embed(embedOptions);

    const row = new Discord.MessageActionRow();

    row.addComponents([
      new Discord.MessageButton()
        .setCustomId(`${id.toLowerCase()}PreviousPage`)
        .setEmoji("⬅️")
        .setLabel("Previous")
        .setStyle("PRIMARY")
        .setDisabled(false),
      new Discord.MessageButton()
        .setCustomId(`${id.toLowerCase()}PageDisplay`)
        .setLabel(`Page ${page + 1} of ${maxPage}`)
        .setStyle("SECONDARY")
        .setDisabled(true),
      new Discord.MessageButton()
        .setCustomId(`${id.toLowerCase()}NextPage`)
        .setEmoji("➡️")
        .setLabel("Next")
        .setStyle("PRIMARY")
        .setDisabled(false)
    ]);

    const msg =
      send === undefined
        ? await interaction.reply({
            embeds: [embed],
            components: maxPage === 1 ? undefined : [row],
            fetchReply: true
          })
        : await send(embed, row, currentEntries);

    if (interaction.channel === null) {
      console.log("Channel is null");

      return;
    }

    const collector = interaction.channel?.createMessageComponentCollector({
      componentType: "BUTTON",
      dispose: true,
      message: msg,
      time: Client.timeoutTime
    });

    collector.on("collect", (buttonInteraction) => {
      if (!buttonInteraction.isButton()) {
        return;
      }

      buttonInteraction.deferUpdate();

      if (buttonInteraction.customId === `${id.toLowerCase()}PreviousPage`) {
        if (page <= 0) {
          page = 0;
          return;
        }

        page--;
      } else if (buttonInteraction.customId === `${id.toLowerCase()}NextPage`) {
        if (page >= maxPage - 1) {
          page = maxPage - 1;
          return;
        }

        page++;
      }

      if (embedOptions.fields === undefined) {
        embedOptions.fields = [];
      }

      const pageChangeEntries = entries.slice(
        page * amount,
        page * amount + amount
      );

      embedOptions.fields[
        embedOptions.fields.findIndex((field) => field.name === fieldName)
      ] = {
        name: fieldName,
        value: pageChangeEntries.join("\n") || "None",
        inline: false
      };

      embed = this.embed(embedOptions);
      if (onPageChange !== undefined) {
        embed = onPageChange(embed, pageChangeEntries);
      }

      if (row.components[1]) {
        (row.components[1] as Discord.MessageButton).setLabel(
          `Page ${page + 1} of ${maxPage}`
        );
      }

      interaction.editReply({
        embeds: [embed],
        components: maxPage === 1 ? undefined : [row]
      });
      buttonInteraction.update({});
    });
  }

  public async awaitMessageComponent<T extends Discord.MessageComponentType>(
    channel: Discord.TextBasedChannel | null | undefined,
    filter: Discord.CollectorFilter<
      [Discord.MessageComponentInteraction<"cached">]
    >,
    componentType: T,
    time = Client.timeoutTime
  ): Promise<Discord.MappedInteractionTypes[T] | undefined> {
    return channel
      ?.awaitMessageComponent({
        componentType,
        filter,
        time,
        dispose: true
      })
      .catch(() => undefined);
  }

  public async logInBotLogChannel(
    message: string
  ): Promise<Discord.Message | undefined> {
    const botLogChannel = await this.getChannel("botLog");

    if (botLogChannel !== undefined) {
      return botLogChannel.send(message);
    }

    return;
  }

  public get guild(): Promise<Discord.Guild | undefined> {
    return this.guilds.fetch({
      guild: this.clientOptions.guildID,
      cache: true
    });
  }

  public getCommandsByCategory(category: string): MonkeyTypes.Command[] {
    return Array.from(
      this.commands.filter((cmd) => cmd.category === category).values()
    );
  }

  public async getWPMRole(wpm: number): Promise<Discord.Role | undefined> {
    const guild = await this.guild;

    if (guild === undefined) {
      return;
    }

    const roleID = this.clientOptions.wpmRoles.find(
      (role) => role.min <= wpm && wpm <= role.max
    )?.id;

    if (roleID === undefined) {
      return;
    }

    return (await guild.roles.fetch(roleID)) ?? undefined;
  }

  public async removeAllWPMRoles(member: Discord.GuildMember): Promise<void> {
    const guild = await this.guild;

    if (guild === undefined) {
      return;
    }

    const roles = this.clientOptions.wpmRoles.map((role) => role.id);

    const containedRoles = member.roles.cache.filter((role) =>
      roles.includes(role.id)
    );

    await member.roles.remove(containedRoles, "Removing WPM Roles");
  }

  public getUserWPMFromRole(member: Discord.GuildMember): number | undefined {
    const roles = this.clientOptions.wpmRoles.map((role) => role.id);

    const roleID = member.roles.cache.find((role) =>
      roles.includes(role.id)
    )?.id;

    if (roleID === undefined) {
      return;
    }

    const role = this.clientOptions.wpmRoles.find((role) => role.id === roleID);

    if (role === undefined) {
      return;
    }

    return role.max;
  }

  public async getChannel(
    channel: keyof MonkeyTypes.Channels
  ): Promise<Discord.TextChannel | undefined> {
    const guild = await this.guild;

    const guildChannel = guild?.channels?.cache.find(
      (ch) => ch.id === this.clientOptions.channels[channel]
    );

    if (!guildChannel?.isText()) {
      return;
    }

    if (guildChannel.type !== "GUILD_TEXT") {
      return;
    }

    return guildChannel;
  }
}
