# 用harness解决

Iron Giant
@irongiantXBT
Your Grok Bot Is Burning Money - Harness Fixes It
Most grok bot setups are one model doing everything. it writes, it routes, it judges, it approves, it checks its own homework.
that's why they're slow, expensive and strange at 3 am.
the setups that hold up split the work into four layers:
grok writes
jev decides
the harness enforces
the swarm scales
this is the whole stack in 6 parts: 10 copy-paste prompts, 3 worked examples, 8 diagrams.
PART 1: THE HARNESS (the part nobody shows you)
agent = model + harness.
the model is grok. the harness is everything around it: the loop that runs it, the tools it can touch, where its memory lives, what it may never do, and how its work gets checked.
same model, different harness, different agent. in july, cursor handed an agent swarm the 835-page sqlite manual and asked for sqlite in rust - same model, old harness vs new. merge conflicts went from 70,000+ to under 1,000.
a grok bot harness has six parts:
a chief that routes and never executes
a contract for every bot: job, sources, judgment, output, forbidden
/workspace - files instead of chat, so context survives handoffs
three gates: source, evidence, action
a HANDOFF.md at the end of every task
an ACTION_LOG.md you own
all your bots already share one persistent cloud computer with /workspace for files that should last. the harness is just deciding how they use it.
prompt 1 - install the chief (paste into your main grok bot)
xml
you are my chief of staff. you route, you never execute.

for every request:
1) triage it
2) pick the specialist bot that owns it
3) write the task to /workspace/tasks/[date]-[slug].md with goal, inputs, acceptance criteria and deadline
4) watch for its HANDOFF.md
5) collect the deliverable and send me a 3-line summary
6) escalate to me only for money, publishing, deletion, signatures or anything a stranger will see

if you catch yourself researching, writing or checking numbers, stop and delegate.
never ask me for context that already lives in /workspace.
prompt 2 - give every bot a contract
xml
create a bot called [name].

JOB: [the outcome it owns]
SOURCES: [urls, folders, apps it may trust]
JUDGMENT: [how it decides good / bad / complete]
OUTPUT: [the file it writes and where]
FORBIDDEN: [what it never touches]

it reads from /workspace/[in-folder], writes to /workspace/[out-folder] and ends every task with /workspace/handoffs/[task].md.
repeat the contract back to me before your first task.
if you can't fill in FORBIDDEN, you don't know the role yet.
PART 2: JEV - THE DECISION LAYER
here's the leak most people miss. most turns in an agent loop don't write anything. they decide something: which file to open, which model to use, is this safe to run, is this done, is this worth keeping.
and every one of those calls goes to the same expensive model, in the same giant context, answered in prose your harness then has to parse.
jev is built for exactly that job. it's typesafe ai's system one model: you send state plus typed questions, it sends back typed answers with probabilities - no prose. three question types:
choice - pick one option (route, tier, team)
score - rate on a rubric (quality, risk, urgency)
noul - one yes/no, returned as a probability from 0 to 1
jev costs $0.042 per million input tokens and output is free. end-to-end latency is 70-500 ms.
quick math for one routing decision, 2,000 tokens in and 150 out:
grok 4.7 ($2 in / $6 out per 1M): about $0.0049
jev ($0.042 in, output free): about $0.000084
that's ~58x cheaper per decision. at 10,000 decisions a day it's ~$49 vs ~$0.84.
what it looks like in code (the typesafe python sdk):
python
from typesafe_sdk import Choice, Noul, TypeSafeClient

client = TypeSafeClient(model="jev-1.13.0")
r = client.system_one(state=step, questions={
    "tier": Choice(
        instructions="Which model should take this step?",
        criteria={
            "cheap":    "Local mechanical edit, low risk.",
            "frontier": "New design or unread code.",
            "ask":      "Brief unclear; a person decides.",
        }),
    "destructive": Noul(instructions="Will this delete or overwrite data?"),
})

# the policy stays in your code, not in the model
if r.answers["destructive"].noul > 0.5:
    park_for_approval(step)
elif r.answers["tier"].choice == "ask" or r.answers["tier"].confidence < 0.75:
    escalate_to_chief(step)
the 5 decisions to move to jev first:
which files? - score the search hits, read the top 3
which model? - choice: cheap / mid / frontier / ask
safe to run? - one noul per risk: delete, network, history rewrite
done? - noul against fresh test output, not the bot's own summary
keep or drop? - score each tool output before context compaction
prompt 3 - make grok bot ask jev before it decides
xml
new skill: decision-first.

before any step that picks between options, rates quality or answers yes/no, don't decide it in prose.
write it as a jev request in /workspace/decisions/[step].json:
- state = only the facts that matter, under 2,000 tokens
- questions = each one choice, score or noul with clear criteria

run /workspace/tools/jev.py on it, save the answers next to the request, then act with these thresholds:
- any risk noul > 0.5 = park for my approval
- choice confidence < 0.75 = ask the chief

quote jev's numbers, never paraphrase them.
PART 3: THE SWARM
one chief, a few specialist teams, one shared bus. that's the whole topology. spacexai's own people run it this way - a "chief of staff" bot stacked above specialists for recruiting, expenses, bug fixes and inbox.
five rules keep it sane:
hire by bottleneck, not by app. no "gmail bot", no "chrome bot"
start with chief + one specialist. add the next only when work waits
teams talk through /workspace + one thread, never long chats
code goes to cursor cloud agents in isolated vms; grok bot owns the outcome
one neutral merge agent lands the work
you have room: an account holds up to 50 bots and group chats combined. you won't need half of them.
prompt 4 - the handoff file
xml
every task you finish ends with /workspace/handoffs/[task].md in this exact shape:

TASK: [what you were asked]
STATUS: complete / partial / blocked
OUTPUT: [path to the deliverable]
SOURCES: [links, files, timestamps, screenshots]
NEXT OWNER: [bot name]
DECISIONS: [what you chose and why]
UNCERTAINTIES: [what you're unsure of]
DO-NOT-ASSUME: [what the next bot must re-check]

no handoff file means the task isn't done.
prompt 5 - the three gates
xml
add three gates to every routine that touches the outside world.

SOURCE GATE: inputs come only from [approved sources]; anything else = STOP and tell the chief.
EVIDENCE GATE: tag every claim VERIFIED, INFERRED or UNKNOWN, ask jev the noul 'is this claim supported by the attached source?' and drop anything under 0.7.
ACTION GATE: prepare every send, publish, payment, deletion or signature as a draft in /workspace/approvals and wait for my ok.

no routine bypasses a gate.
prompt 6 - the merge agent
xml
create a bot called merge.
it owns one queue: /workspace/approved. it never writes features.

for each incoming handoff:
- confirm tests pass and the evidence gate is green
- resolve conflicts without favouring either author
- ask jev the noul 'does this change overwrite data or rewrite history?' and send anything above 0.3 to me

log every merge to /workspace/ACTION_LOG.md.
PART 4: THE FULL STACK, IN ONE PICTURE
here's the difference in one line: a single bot thinks in prose about everything. the stack sends writing to grok, decisions to jev, rules to the harness and volume to the swarm.
who does what:
layer
job
runs on
what it costs you
grok
writes code, drafts, plans
grok 4.7
$2 in / $6 out per 1M
jev
routes, scores, says yes/no
jev-1.13.0
$0.042 in per 1M, output free
harness
contracts, gates, handoffs, logs
/workspace + skills
your time, once
swarm
parallel specialists, merge
grok bot + cursor cloud agents
more bots = more tokens, so add slowly
the expensive model stays in the loop. it just stops paying for every small decision.
PART 5: THREE WORKED EXAMPLES
example 1 - inbox triage (the best first swarm)
inbox bot reads new mail every hour
jev answers three questions per message: team (choice), urgency 1-5 (score), "needs a human before any reply?" (noul)
support bot drafts replies only when urgency ≤ 3 and the noul is under 0.3
everything else lands in /workspace/approvals with a draft
the chief sends you one summary at 9:00 and 17:00
prompt 7 - inbox triage routine
xml
routine, every hour: pull unread mail from [inbox].

for each message build a jev request.
state = sender, subject, first 800 characters, number of past messages in the thread.
questions:
- team (choice: sales / support / billing / spam)
- urgency (score 1-5)
- human_first (noul: 'does a person need to see this before any reply?')

route:
- spam = archive
- human_first > 0.3 or urgency ≥ 4 = /workspace/approvals with a draft
- everything else = hand to [support bot] to draft and queue

stay silent unless something lands in approvals.
example 2 - content engine
research bot collects sources into /workspace/research
writer bot drafts only from those sources
jev scores every draft 1-5 on clarity, evidence and hook
anything under 4 goes back once, with the weakest score named
you approve the final; nothing auto-publishes
prompt 8 - quality gate for drafts
xml
before any draft leaves /workspace/drafts, send it to jev with three score questions:
- clarity (1-5)
- evidence ('every claim has a source in /workspace/research', 1-5)
- hook (1-5)

if any score is under 4, return it to [writer bot] once with the lowest score and the sentence that caused it.
if it fails twice, park it for me.
put the scores in the handoff file.
example 3 - code swarm
grok bot is the tech lead and splits the ticket into units you can test alone
it launches one cursor cloud agent per unit, each with scope, acceptance criteria and non-goals
jev checks every shell command: "will this delete or overwrite data?"
the merge bot lands the pull requests; you approve anything irreversible
prompt 9 - tech lead
xml
you own the outcome of [ticket].

1) split it into the smallest set of units that can each be tested on their own.
2) for each unit launch one cursor cloud agent with exact scope, acceptance criteria, non-goals and the files it may touch - never more agents than units.
3) before any shell command ask jev (noul): 'will this delete files, reach the network or rewrite git history?' anything above 0.2 waits for me.
4) when every unit is green, hand the pull requests to merge with one HANDOFF.md.
PART 6: THE CHECKLIST
run down this list before you add bot number two.
the chief exists before any specialist
every bot has a 5-field contract
/workspace has research, drafts, evidence, approvals, handoffs
decisions go to jev, writing goes to grok
three gates on every external action
one merge agent and one ACTION_LOG.md
silent by default, notify on exception
prompt 10 - the weekly audit
xml
every friday at 16:00 read /workspace/ACTION_LOG.md and /workspace/decisions for the week.

report:
- decisions sent to jev vs decided in prose
- average jev confidence per question
- routines that woke up and found nothing
- approvals that waited more than 4 hours
- any bot that wrote outside its folder

suggest one rule to tighten and one bot to retire.
change nothing without my ok.
THE SHORT VERSION
grok gives you the brain. jev gives you cheap, honest decisions. the harness keeps both inside the lines. the swarm gives you hands.
build it in that order: chief, contracts, /workspace, gates, jev, then the second bot.
set up the chief tonight.

