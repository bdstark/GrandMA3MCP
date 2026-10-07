export const CHEATSHEET = `# grandMA3 command line cheat sheet (for gma3_command / gma3_lua)

Commands are typed without a trailing Please/Enter. Keywords are case-insensitive. Object addressing is
"<Keyword> <number>" and ranges use Thru / + / - ("Fixture 1 Thru 10 - 5", "Sequence 1 + 3").
Executors are addressed by page: "Page 1.201" or "Executor 201" (current page). Fader rows are 201-215
(onPC: faders 201-215 are the main faders, 101-115 the keys above, 301-315 the row above that).

## Selection and values
- Fixture 1 Thru 10            select fixtures 1..10
- Group 3                      select group 3 (default function of Group is SelFix)
- Fixture 1 At 50              dimmer 50% (At = value for the selected feature)
- Attribute "Pan" At 20        set an attribute of the selection
- Preset 4.1                   call preset (pool 4 = Color, 1 = Dimmer, 2 = Position, 3 = Gobo, 5 = Beam, 6 = Focus, 7 = Control, 8 = Shapers, 9 = Video, 21..= All)
- Clear / ClearAll / Off Programmer   clear selection / everything in the programmer
- SelFix Sequence 1 Cue 2      select fixtures used in a cue
- Highlight / Lowlight / Blind / Freeze / Solo   programmer toggles

## Store and edit
- Store Cue 1                  store programmer into cue 1 of the selected sequence
- Store Sequence 2 Cue 1.5 "Name" /Merge /NoConfirmation
- Store Preset 4.3 /Universal  store a color preset
- Store Group 7 "Name"
- Label Sequence 1 "Main"      rename
- Delete Sequence 1 Cue 3 /NoConfirmation
- Copy Cue 1 At 4 / Move Group 1 At 10
- Assign Sequence 1 At Page 1.201      assign to an executor
- Assign Cue 1 /Fade 2 /Delay 0.5      cue timing via options ( /Fade /OutFade /Delay /OutDelay /Trig Time /TrigTime 3 )
- Set Cue 2 Property "TrigType" "Follow"   or   Assign Cue 2 /TrigType=Follow
- Cue 2 Fade 3                  shorthand for fade time of a cue (selected sequence)
- Store Sequence 1 Cue 1 /Merge   merge programmer into an existing cue

## Playback
- Go+ Sequence 1 / Go- / Pause / Off / On / Top / Flash / Toggle / Select / Load Sequence 1 Cue 5
- Go+ Executor 201 / Off Page 1.201 / Off Sequence Thru (all)
- Goto Cue 5                   jump the selected sequence to cue 5 (shortcut for Go+ Cue 5)
- FaderMaster Sequence 1 At 50 Fade 2 / FaderMaster Page 1.201 At 100
- Master 2.1 At 80 (grand master = Master 2.1; speed masters 3.x; playback masters 2.x)
- Select Sequence 1            make it the selected sequence (shown in the Sequence Sheet)
- Pause / Resume

## Patch and show
- Patch Fixture 1 1.1          patch to universe 1 address 1 (Edit Patch menu for full control)
- Fixture 1 Thru 10 Property "Name" "Spot %"
- SaveShow / SaveShow "Name" / LoadShow "Name" / NewShow
- List, Dump                   print to the command line history (not returned over the bridge)
- Menu "Patch" / Menu "Settings" / Menu "DisplayConfig"
- Lua "Printf('hi')"           run inline Lua from the command line
- Plugin "name" "argument"     run a plugin
- SendOSC 1 "/path,i,1"        send OSC from line 1 of the OSC configuration

## Show data paths (for gma3_get_object / gma3_lua)
Root
  ShowData                       -> ShowData()
    DataPools.Default            -> DataPool()   children: Sequences, Groups, PresetPools, Macros, Pages,
                                                  Worlds, Filters, Timecodes, Timers, Layouts, Views, MAtricks,
                                                  Appearances, Plugins, ScreenConfigurations, Cameras, Sounds...
    Patch (LivePatch)            -> Patch()      children: Fixtures, FixtureTypes, Stages, DmxUniverses...
    UserProfiles, Users, Masters...
Numeric addresses look like 14.14.1.6.1 (Sequence 1) and can change between software versions.

Lua essentials:
- ObjectList("Sequence 1 Cue 3")[1]       handle from command syntax
- DataPool().Sequences:Children()         table of handles
- h.name, h:GetClass(), h:Addr(), h:Count(), h:Ptr(i), h:Parent(), h:Children()
- h:Get("Prop", Enums.Roles.Edit)         property as display text; h:Set("Prop","value")
- h:PropertyCount(), h:PropertyName(i)    enumerate properties
- seq:HasActivePlayback(), seq:GetFader({token="FaderMaster"}), seq:SetFader({value=50})
- GetExecutor(201) -> execHandle, pageHandle ; exec.Object is the assigned object
- SelectedSequence(), GetCurrentCue(), CurrentExecPage(), Selection(), Programmer()
- Cmd("Go+ Sequence 1") -> feedback string ; CmdIndirect(...) for UI commands (menus)
- GetVar(UserVars(),"name") / SetVar(UserVars(),"name",value)
- GetDMXValue(address, universe), GetDMXUniverse(universe)
`;
