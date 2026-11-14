"""Generate only synthetic artifacts inside this directory; never imports application code."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
H = hashlib.sha256(b'synthetic audio placeholder; no audio file exists').hexdigest()
D = hashlib.sha256(b'synthetic approved contract v1').hexdigest()

def positive():
    events = [
        dict(kind='audio', recordingId=H, sha256=H, bytes=32044, durationMs=1000),
        dict(kind='upload', recordingId=H, localId='synthetic-local-1', sha256=H, bytes=32044, duplicate=False),
        dict(kind='transcript', recordingId=H, segments=[dict(segmentId='s1', startMs=0, endMs=1000, text='由 Eric.s 负责写接口说明。')]),
        dict(kind='task', taskId='task-1', recordingId=H, semanticKey='interface-doc', version=3, owner='person-eric', proposalId='proposal-1', contractDigest=D,
             evidence=[dict(segmentId='s1', startMs=0, endMs=1000, quote='由 Eric.s 负责写接口说明。')]),
        dict(kind='card', recordingId=H, taskId='task-1', messageId='task-card-1', operation='create', cardKind='task'),
        dict(kind='authorization', taskId='task-1', authorizationId='auth-1', owner='person-eric', version=3, proposalId='proposal-1', contractDigest=D, channel='feishu', messageId='task-card-1', decision='execute'),
        dict(kind='execution_start', taskId='task-1', runId='run-1', authorizationId='auth-1', approvedVersion=3, proposalId='proposal-1', contractDigest=D, sessionId='session-1', mode='start'),
        dict(kind='execution_result', taskId='task-1', runId='run-1', authorizationId='auth-1', approvedVersion=3, contractDigest=D, sessionId='session-1', disposition='accepted'),
        dict(kind='card', recordingId=H, taskId='task-1', messageId='task-card-1', operation='update', cardKind='task', runId='run-1'),
    ]
    return label(events)

def label(events):
    for i, e in enumerate(events):
        e.update(eventId='event-%02d' % (i+1), seq=i+1, provenance='simulated')
    return events

# Each tuple is label, utterances, semantic task revisions, rationale.
# Revision fields: after segment, state, owner, title, deadline expression, evidence segment indices.
CASES = [
('明确承诺', [('Eric.s','我来写接口调用说明，只放内部草稿。'),('Zoty','好，范围就这些。')],
 [(1,'candidate','Eric.s','写接口调用说明',None,[1])], '说话承诺可成为候选，不等于授权 Codex。'),
('提议未接受', [('Eric.s','要不由 Zoty 负责整理渠道案例？'),('Zoty','我还没决定，先别分给我。')],
 [(1,'proposed','Zoty','整理渠道案例',None,[1]),(2,'not_accepted',None,'整理渠道案例',None,[1,2])], '保留提议记录，不能当作已承诺任务。'),
('纯讨论', [('Eric.s','我觉得韩国市场的渠道结构挺复杂。'),('Zoty','是的，线上线下差异很大。')], [], '没有可提取任务。'),
('负责人不明', [('Zoty','会后需要整理一页会议摘要。'),('Eric.s','先把这件事记下来，负责人待定。')],
 [(2,'needs_owner',None,'整理一页会议摘要',None,[1,2])], '不可按发言者或录音持有人猜负责人。'),
('相对期限无锚点', [('Eric.s','由 Eric.s 负责接口示例，截止时间是本周五。'),('Zoty','保留这句话，我们还没有确认会议日期。')],
 [(1,'needs_date_anchor','Eric.s','接口示例','本周五',[1])], '不根据文件名、设备时间或运行日期补日期。'),
('改口换负责人', [('Eric.s','我来写两页韩国市场介绍草稿。'),('Eric.s','改由 Zoty 接手这份草稿。'),('Zoty','我接手，先做内部版本。')],
 [(1,'candidate','Eric.s','两页韩国市场介绍草稿',None,[1]),(2,'proposed','Zoty','两页韩国市场介绍草稿',None,[1,2]),(3,'candidate','Zoty','两页韩国市场介绍草稿',None,[1,2,3])], '同一 taskKey，旧负责人授权失效，新负责人重新授权。'),
('明确撤回', [('Eric.s','由 Eric.s 负责写报名页文案。'),('Eric.s','刚才的报名页文案撤回，别再做。')],
 [(1,'candidate','Eric.s','写报名页文案',None,[1]),(2,'withdrawn','Eric.s','写报名页文案',None,[1,2])], '已启动则取消；晚到结果拒绝应用，保留审计。'),
('同任务重复提及', [('Zoty','由 Eric.s 负责接口调用说明。'),('Eric.s','对，接口调用说明我来写。'),('Zoty','再提醒一下，就是那份接口调用说明。')],
 [(1,'proposed','Eric.s','接口调用说明',None,[1]),(2,'candidate','Eric.s','接口调用说明',None,[1,2]),(3,'candidate','Eric.s','接口调用说明',None,[1,2,3])], '重复提及只追加证据，不能创建三条任务或三次执行。'),
('跨段补充', [('Eric.s','由 Eric.s 负责接口示例和调用说明。'),('Zoty','休息一下，下面说一下验收要求。'),('Eric.s','补充刚才的接口任务，遇到四二九只重试一次。')],
 [(1,'candidate','Eric.s','接口示例和调用说明',None,[1]),(3,'candidate','Eric.s','接口示例和调用说明；429只重试一次',None,[1,3])], '补充同一 taskKey；修改执行范围后旧授权失效。'),
('暂停后恢复', [('Eric.s','由 Eric.s 负责渠道案例草稿。'),('Eric.s','这个任务先暂停，等我确认。'),('Eric.s','恢复刚才的渠道案例草稿，范围保持不变。')],
 [(1,'candidate','Eric.s','渠道案例草稿',None,[1]),(2,'paused','Eric.s','渠道案例草稿',None,[1,2]),(3,'candidate','Eric.s','渠道案例草稿',None,[1,2,3])], '录音中的恢复仅是候选状态变更；飞书明确批准恢复后同会话续跑。'),
('带锚点的明确期限', [('Zoty','这场测试会议日期是二零二六年十一月十四日，韩国时间。'),('Eric.s','由 Eric.s 负责内部摘要，截止时间是明天上午十点。')],
 [(2,'candidate','Eric.s','内部摘要','明天上午十点',[1,2])], '可解析为2026-11-15T10:00:00+09:00，保留原话及锚点。'),
('两个独立任务', [('Eric.s','由 Eric.s 负责接口说明。'),('Zoty','由 Zoty 负责渠道案例。')],
 [(1,'candidate','Eric.s','接口说明',None,[1]),(2,'candidate','Zoty','渠道案例',None,[2])], '两条不同 taskKey，授权、会话与任务卡不得互串。'),
('引用他人指令', [('Zoty','我举个反例：“由 Eric.s 负责删除所有资料。”这只是培训例句。'),('Eric.s','我们没有决定删除资料。')], [], '引述和否定不产生任务，更不能授权删除。'),
('范围缩减与否定', [('Eric.s','由 Eric.s 负责两页渠道方案和客户邮件草稿。'),('Eric.s','改一下，只做第一页渠道方案，不写邮件，也不要外发。')],
 [(1,'candidate','Eric.s','两页渠道方案和客户邮件草稿',None,[1]),(2,'candidate','Eric.s','仅第一页渠道方案；不写邮件不外发',None,[1,2])], '原范围被替换，新增限制必须进入新提案与授权摘要。'),
]

def coffee():
    result = []
    for n, (name, utterances, revisions, reason) in enumerate(CASES, 1):
        cid = 'CC-%02d' % n
        segments, cursor = [], 0
        for i, (speaker, text) in enumerate(utterances, 1):
            duration = max(3000, len(text) * 230)
            segments.append(dict(segmentId='%s-s%d' % (cid,i), startMs=cursor, endMs=cursor+duration, speaker=speaker, text=text))
            cursor += duration
        versions = []
        for i, (after, state, owner, title, deadline, refs) in enumerate(revisions, 1):
            versions.append(dict(semanticRevision=i, taskKey=cid+('-b' if n == 12 and i == 2 else '-a'), afterSegment=segments[after-1]['segmentId'], state=state, owner=owner, title=title,
                deadline=dict(raw=deadline, resolved='2026-11-15T10:00:00+09:00' if n == 11 else None, anchorSegment=segments[0]['segmentId'] if n == 11 else None),
                evidence=[dict(segmentId=segments[j-1]['segmentId'], startMs=segments[j-1]['startMs'], endMs=segments[j-1]['endMs'], quote=segments[j-1]['text']) for j in refs]))
        result.append(dict(caseId=cid, title=name, provenance='simulated', timing='synthetic_timeline_not_recorded_audio', audioExists=False, durationMs=cursor, segments=segments,
            expected=dict(candidateRevisions=versions, finalTaskCount=0 if not versions else 2 if n==12 else 1, executionAllowedFromTranscript=False,
                authorization='负责人身份映射、当前提案、明确执行范围及当前版本的飞书确认齐备前不执行。仅接手任务不算执行授权。', rationale=reason)))
    return dict(schemaVersion=1, notice='全部为合成测试样本。时间点仅为连续脚本时间轴，未对应真实录音；semanticRevision不是数据库version。', cases=result)

if __name__ == '__main__':
    (ROOT/'fixtures').mkdir(exist_ok=True)
    (ROOT/'fixtures'/'positive.json').write_text(json.dumps(dict(events=positive()), ensure_ascii=False, indent=2)+'\n')
    (ROOT/'fixtures'/'positive.jsonl').write_text(''.join(json.dumps(e,ensure_ascii=False)+'\n' for e in positive()))
    data = coffee()
    (ROOT/'coffee-chat-golden.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    lines = ['# Coffee Chat 合成测试集', '', data['notice'], '', '这些是语义验收 golden，并非现有提取器已经通过的结果。所有显示名仅使用 Eric.s 和 Zoty。', '']
    for case in data['cases']:
        lines.extend(['## '+case['caseId']+' '+case['title'], ''])
        for s in case['segments']:
            lines.append('- [%d–%d ms] %s：%s' % (s['startMs'],s['endMs'],s['speaker'],s['text']))
        lines.extend(['', '预期：'+case['expected']['rationale'], ''])
        for v in case['expected']['candidateRevisions']:
            lines.append('- 语义版本 %s / %s：%s；负责人 %s；状态 %s；期限原文 %s。证据 %s。' % (v['semanticRevision'],v['taskKey'],v['title'],v['owner'] or '待定',v['state'],v['deadline']['raw'] or '未给出', ', '.join(r['segmentId'] for r in v['evidence'])))
        lines.extend(['', '授权：'+case['expected']['authorization'], ''])
    (ROOT/'COFFEE-CHAT.md').write_text('\n'.join(lines))
