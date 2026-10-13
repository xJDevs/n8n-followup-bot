export const IDS = Object.freeze({
  SENDER: 'WfSendToPatient1',
  TEST_LAUNCHER: 'WfTestSend000001',
  ORCHESTRATOR: 'WfOrchestrator01',
  WEBHOOK: 'WfDeliveryHook01',
  ERROR_MANAGER: 'WfErrorManager01',
  SQL_CONSOLE: 'WfSqlConsole0001',
  YCLOUD_CONSOLE: 'WfYCloudConsole1',
  BACKUP: 'WfBackup00000001',
  DAILY_WATCH: 'WfDailyWatch0001',
  BACKUP_CONSOLE: 'WfBackupConsole1',
});

export const INVENTORY = Object.freeze([
  { id: IDS.SENDER, name: 'Followup | Send To Patient', role: 'sender' },
  {
    id: IDS.TEST_LAUNCHER,
    name: 'Followup | Test Send · OPEN 24H WINDOW FIRST',
    role: 'test-launcher',
  },
  { id: IDS.ORCHESTRATOR, name: 'Followup | Bot', role: 'orchestrator' },
  { id: IDS.WEBHOOK, name: 'Followup | Delivery Webhook', role: 'webhook' },
  { id: IDS.ERROR_MANAGER, name: 'Followup | Error Manager', role: 'error-manager' },
  { id: IDS.SQL_CONSOLE, name: 'Followup | SQL Console', role: 'console' },
  { id: IDS.YCLOUD_CONSOLE, name: 'Followup | YCloud Console', role: 'console' },
  { id: IDS.BACKUP, name: 'Followup | Backup', role: 'backup' },
  { id: IDS.DAILY_WATCH, name: 'Followup | Daily Watch', role: 'daily-watch' },
  { id: IDS.BACKUP_CONSOLE, name: 'Followup | Backup Console', role: 'console' },
]);

export const INVENTORY_BY_ID = new Map(INVENTORY.map((item) => [item.id, item]));
