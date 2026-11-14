import Foundation

public struct UploadTaskSnapshot {
    public let taskID: Int
    public let recordingID: UUID?
    public let isActive: Bool

    public init(taskID: Int, recordingID: UUID?, isActive: Bool) {
        self.taskID = taskID
        self.recordingID = recordingID
        self.isActive = isActive
    }
}

public struct UploadRecoveryPlan {
    public let retained: [UUID: Int]
    public let cancelTaskIDs: Set<Int>
}

public enum UploadRecovery {
    /// 系统任务列表先完成对账，应用才能为 retained 之外的录音创建新上传任务。
    /// taskID 是同一 URLSession 内唯一标识；取消中和已完成任务应标为非活跃。
    public static func plan(pendingRecordingIDs: Set<UUID>, tasks: [UploadTaskSnapshot]) -> UploadRecoveryPlan {
        var retained: [UUID: Int] = [:]
        var cancelled: Set<Int> = []
        for task in tasks.sorted(by: { $0.taskID < $1.taskID }) where task.isActive {
            guard let recordingID = task.recordingID,
                  pendingRecordingIDs.contains(recordingID),
                  retained[recordingID] == nil else {
                cancelled.insert(task.taskID)
                continue
            }
            retained[recordingID] = task.taskID
        }
        return UploadRecoveryPlan(retained: retained, cancelTaskIDs: cancelled)
    }
}
