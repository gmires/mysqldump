import * as fs from 'fs';
import * as mysql from 'mysql2';
import * as sqlformatter from 'sql-formatter';
import { all as merge } from 'deepmerge';

import { ConnectionOptions, DataDumpOptions } from './interfaces/Options';
import { Table } from './interfaces/Table';
import { typeCast } from './typeCast';

import { DB } from './DB';

interface QueryRes {
    [k: string]: unknown;
}

interface ShowIndex {
    Table: string;
    Non_unique: number;
    Key_name: string;
    Seq_in_index: number;
    Column_name: string;
    Collation: string;
    Cardinality: number;
    Sub_part?: string;
    Packed?: string;
    Null?: string;
    Index_type: string;
    Comment: string;
    Index_comment: string;
}

function buildReplace(
    table: Table,
    values: Array<string>,
    format: (s: string) => string,
): string {
    const sql = format(
        [
            `REPLACE INTO \`${table.name}\` (\`${table.columnsOrdered.join(
                '`,`',
            )}\`)`,
            `VALUES ${values.join(',')};`,
        ].join(' '),
    );

    // sql-formatter lib doesn't support the X'aaff' or b'01010' literals, and it adds a space in and breaks them
    // this undoes the wrapping we did to get around the formatting
    return sql.replace(/NOFORMAT_WRAP\("##(.+?)##"\)/g, '$1');
}
function buildInsert(
    table: Table,
    values: Array<string>,
    format: (s: string) => string,
): string {
    const sql = format(
        [
            `INSERT INTO \`${table.name}\` (\`${table.columnsOrdered.join(
                '`,`',
            )}\`)`,
            `VALUES ${values.join(',')};`,
        ].join(' '),
    );

    // sql-formatter lib doesn't support the X'aaff' or b'01010' literals, and it adds a space in and breaks them
    // this undoes the wrapping we did to get around the formatting
    return sql.replace(/NOFORMAT_WRAP\("##(.+?)##"\)/g, '$1');
}
function buildInsertValue(row: QueryRes, table: Table): string {
    return `(${table.columnsOrdered.map(c => row[c]).join(',')})`;
}

function executeSql(connection: mysql.Connection, sql: string): Promise<void> {
    return new Promise((resolve, reject) =>
        connection.query(sql, err =>
            err ? /* istanbul ignore next */ reject(err) : resolve(),
        ),
    );
}

function getDropIndex(connection: DB, table: Table): Promise<Array<string>> {
    return new Promise(async (resolve, reject) => {
        try {
            let r = [];
            let result = await connection.query<ShowIndex>(`SHOW INDEX FROM ${table.name}`);
            let results = result
                .filter((item: ShowIndex) => item.Key_name != 'PRIMARY')
                .filter((item: ShowIndex) => item.Non_unique == 1)
                .reduce((acc: any, item: ShowIndex) => {
                    acc[item.Key_name] = [...acc[item.Key_name] || [], item.Column_name];
                    return acc;
                }, {});

            var indexes_addt = [];
            var indexes_drop = [];
            for (let key in results) {
                indexes_drop.push(`DROP INDEX \`${key}\` on ${table.name};`);
                indexes_addt.push(`ADD INDEX \`${key}\` (${results[key].map((v: string) => `\`${v}\``).join(',')})`);
            }

            if (indexes_addt.length > 0) {
                r.push(indexes_drop.join('\n '));
                r.push(`ALTER TABLE \`${table.name}\`\n ${indexes_addt.join('\n ')};`);
            }

            resolve(r);
        } catch (error) {
            reject(error);
        }
    });
}

// eslint-disable-next-line complexity
async function getDataDump(
    connectionOptions: ConnectionOptions,
    options: Required<DataDumpOptions>,
    tables: Array<Table>,
    dumpToFile: string | null,
    dbconnection?: DB
): Promise<Array<Table>> {
    // ensure we have a non-zero max row option
    options.maxRowsPerInsertStatement = Math.max(
        options.maxRowsPerInsertStatement,
        0,
    );

    // clone the array
    tables = [...tables];

    // build the format function if requested
    const format = options.format
        ? (sql: string) => sqlformatter.format(sql)
        : (sql: string) => sql;

    // we open a new connection with a special typecast function for dumping data
    const connection = mysql.createConnection(
        merge([
            connectionOptions,
            {
                multipleStatements: true,
                typeCast: typeCast(tables),
            },
        ]),
    );

    const retTables: Array<Table> = [];
    let currentTableLines: Array<string> | null = null;

    // open the write stream (if configured to)
    const outFileStream = dumpToFile
        ? fs.createWriteStream(dumpToFile, {
            flags: 'a', // append to the file
            encoding: 'utf8',
        })
        : null;

    function saveChunk(str: string | Array<string>, inArray = true): void {
        if (!Array.isArray(str)) {
            str = [str];
        }

        // write to file if configured
        if (outFileStream) {
            str.forEach(s => outFileStream.write(`${s}\n`));
        }

        // write to memory if configured
        if (inArray && currentTableLines) {
            currentTableLines.push(...str);
        }
    }

    try {
        if (options.lockTables) {
            // see: https://dev.mysql.com/doc/refman/5.7/en/replication-solutions-backups-read-only.html
            await executeSql(connection, 'FLUSH TABLES WITH READ LOCK');
            await executeSql(connection, 'SET GLOBAL read_only = ON');
        }

        // to avoid having to load an entire DB's worth of data at once, we select from each table individually
        // note that we use async/await within this loop to only process one table at a time (to reduce memory footprint)
        while (tables.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const table = tables.shift()!;

            if (table.isView && !options.includeViewData) {
                // don't dump data for views
                retTables.push(
                    merge<Table>([
                        table,
                        {
                            data: null,
                        },
                    ]),
                );

                // eslint-disable-next-line no-continue
                continue;
            }

            currentTableLines = options.returnFromFunction ? [] : null;

            if (retTables.length > 0) {
                // add a newline before the next header to pad the dumps
                saveChunk('');
            }

            if (options.verbose) {
                // write the table header to the file
                const header = [
                    '# ------------------------------------------------------------',
                    `# DATA DUMP FOR TABLE: ${table.name}${options.lockTables ? ' (locked)' : ''
                    }`,
                    '# ------------------------------------------------------------',
                    '',
                ];
                saveChunk(header);
            }

            let indexArray: Array<string> = []
            if (options.dropIndex && dbconnection) {
                indexArray = await getDropIndex(dbconnection, table);
            }

            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve, reject) => {
                // send the query
                const where = options.where[table.name]
                    ? ` WHERE ${options.where[table.name]}`
                    : '';
                const query = connection.query(
                    `SELECT * FROM \`${table.name}\`${where}`,
                );

                let rowQueue: Array<string> = [];

                // stream the data to the file
                query.on('result', (row: QueryRes) => {
                    // build the values list
                    rowQueue.push(buildInsertValue(row, table));

                    if ((rowQueue.length > 0) && (indexArray.length == 2) && (indexArray[0] != '')) {
                        saveChunk(indexArray[0]);
                        indexArray[0] = '';
                    }

                    // if we've got a full queue
                    if (rowQueue.length === options.maxRowsPerInsertStatement) {
                        // create and write a fresh statement
                        const insert =
                            options.useReplace ?
                                buildReplace(table, rowQueue, format) :
                                buildInsert(table, rowQueue, format);
                        saveChunk(insert);
                        rowQueue = [];
                    }
                });
                query.on('end', () => {
                    // write the remaining rows to disk
                    if (rowQueue.length > 0) {
                        const insert =
                            options.useReplace ?
                                buildReplace(table, rowQueue, format) :
                                buildInsert(table, rowQueue, format);
                        saveChunk(insert);
                        rowQueue = [];
                    }

                    // if dropIndex array[1] != '' write create
                    if ((indexArray[1] != '') && (indexArray[0] == '') && (indexArray.length == 2)) {
                        saveChunk(indexArray[1]);
                        indexArray[1] = '';
                    }
                    resolve();
                });
                query.on(
                    'error',
                    /* istanbul ignore next */ err => reject(err),
                );
            });

            // update the table definition
            retTables.push(
                merge<Table>([
                    table,
                    {
                        data: currentTableLines
                            ? currentTableLines.join('\n')
                            : null,
                    },
                ]),
            );
        }

        saveChunk('');
    } finally {
        if (options.lockTables) {
            // see: https://dev.mysql.com/doc/refman/5.7/en/replication-solutions-backups-read-only.html
            await executeSql(connection, 'SET GLOBAL read_only = OFF');
            await executeSql(connection, 'UNLOCK TABLES');
        }
    }

    // clean up our connections
    await ((connection.end() as unknown) as Promise<void>);

    if (outFileStream) {
        // tidy up the file stream, making sure writes are 100% flushed before continuing
        await new Promise(resolve => {
            outFileStream.once('finish', () => {
                resolve();
            });
            outFileStream.end();
        });
    }

    return retTables;
}

export { getDataDump };
