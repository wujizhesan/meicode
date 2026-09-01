export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'

export interface A2APart {
  kind: 'text'
  text: string
}

export interface A2AMessage {
  messageId: string
  role: 'ROLE_USER' | 'ROLE_AGENT'
  parts: A2APart[]
  contextId?: string
  taskId?: string
}

export interface A2AStatus {
  state: TaskState
  timestamp: string
  message?: A2AMessage
}

export interface A2AArtifact {
  artifactId: string
  name?: string
  parts: A2APart[]
}

export interface A2ATask {
  id: string
  contextId: string
  status: A2AStatus
  history: A2AMessage[]
  artifacts: A2AArtifact[]
}

export interface A2AStreamResponse {
  task?: A2ATask
  statusUpdate?: { taskId: string; contextId: string; status: A2AStatus; final?: boolean }
  artifactUpdate?: { taskId: string; contextId: string; artifact: A2AArtifact; append: boolean; lastChunk: boolean }
}

export interface A2APushNotificationConfig {
  id: string
  taskId: string
  url: string
  token?: string
  authentication?: { scheme: string; credentials: string }
}

export interface A2AStoredTask {
  task: A2ATask
  pushNotificationConfigs: A2APushNotificationConfig[]
}
