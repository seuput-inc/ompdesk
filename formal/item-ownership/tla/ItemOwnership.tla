------------------------- MODULE ItemOwnership -------------------------
EXTENDS Naturals, FiniteSets

Peers == {1, 2}
Epochs == 1..2
Keys == Epochs \X Peers

VARIABLES epoch, proposed, saved, wire, opened, prompted, online, diskOK,
          acceptedA, question, envelope, received
vars == <<epoch, proposed, saved, wire, opened, prompted, online, diskOK,
          acceptedA, question, envelope, received>>
NoMail == <<0, 0>>
Ready == acceptedA /\ question = "owner_allowed"
Init == /\ epoch = 1 /\ proposed = 0 /\ saved = [g \in Epochs |-> 0]
        /\ wire = {} /\ opened = {} /\ prompted = {}
        /\ online = Peers \cup {0} /\ diskOK = TRUE
        /\ acceptedA = FALSE /\ question = "pending"
        /\ envelope = NoMail /\ received = NoMail

\* The owner is host 0. A proposal is volatile, not an affirmative receipt.
Propose(p) == /\ 0 \in online /\ p \in online /\ saved[epoch] = 0 /\ proposed = 0
              /\ Ready
              /\ proposed' = p
              /\ UNCHANGED <<epoch, saved, wire, opened, prompted, online, diskOK, acceptedA, question, envelope, received>>
Persist == /\ 0 \in online /\ diskOK /\ proposed \in Peers /\ saved[epoch] = 0
           /\ saved' = [saved EXCEPT ![epoch] = proposed]
           /\ UNCHANGED <<epoch, proposed, wire, opened, prompted, online, diskOK, acceptedA, question, envelope, received>>
OwnerRestart == /\ proposed' = 0
                /\ UNCHANGED <<epoch, saved, wire, opened, prompted, online, diskOK, acceptedA, question, envelope, received>>
SendOpen(p) == /\ 0 \in online /\ (p = proposed \/ p = saved[epoch])
               /\ saved[epoch] = p
               /\ wire' = wire \cup {<<epoch,p>>}
               /\ UNCHANGED <<epoch, proposed, saved, opened, prompted, online, diskOK, acceptedA, question, envelope, received>>
\* The receiver's durable open and first-prompt receipts are separate. Lost ACKs can replay a wire key.
Open(k) == /\ k \in wire /\ k[1] = epoch /\ k[2] \in online /\ k \notin opened
           /\ opened' = opened \cup {k}
           /\ UNCHANGED <<epoch, proposed, saved, wire, prompted, online, diskOK, acceptedA, question, envelope, received>>
Prompt(k) == /\ k \in opened /\ k[1] = epoch /\ k[2] \in online /\ k \notin prompted
             /\ prompted' = prompted \cup {k}
             /\ UNCHANGED <<epoch, proposed, saved, wire, opened, online, diskOK, acceptedA, question, envelope, received>>
\* An acknowledged safe stop is required for reassignment; timeout or link loss is not one.
SafeRelease == /\ 0 \in online /\ saved[epoch] \in online \cap Peers /\ epoch < 2
               /\ epoch' = epoch + 1 /\ proposed' = 0
               /\ UNCHANGED <<saved, wire, opened, prompted, online, diskOK, acceptedA, question, envelope, received>>
QueueMail == /\ 0 \in online /\ envelope = NoMail /\ <<epoch,saved[epoch]>> \in opened
             /\ envelope' = <<epoch,saved[epoch]>>
             /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, online, diskOK, acceptedA, question, received>>
Deliver == /\ envelope # NoMail /\ received = NoMail
           /\ 0 \in online /\ saved[epoch] \in online \cap Peers /\ <<epoch,saved[epoch]>> \in opened
           /\ envelope[1] = epoch
           /\ received' = <<epoch,saved[epoch]>>
           /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, online, diskOK, acceptedA, question, envelope>>
RejectLate == /\ 0 \in online /\ envelope # NoMail /\ received = NoMail /\ envelope[1] # epoch
              /\ received' = <<0,1>>
              /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, online, diskOK, acceptedA, question, envelope>>
QuestionResult(q) == /\ 0 \in online /\ question = "pending"
                     /\ question' = q
                     /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, online, diskOK, acceptedA, envelope, received>>
AcceptA == /\ 0 \in online /\ acceptedA' = TRUE
           /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, online, diskOK, question, envelope, received>>
Link(h) == /\ online' = IF h \in online THEN online \ {h} ELSE online \cup {h}
           /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, diskOK, acceptedA, question, envelope, received>>
Disk == /\ diskOK' = ~diskOK
        /\ UNCHANGED <<epoch, proposed, saved, wire, opened, prompted, online, acceptedA, question, envelope, received>>
Next == Persist \/ OwnerRestart \/ SafeRelease \/ QueueMail \/ Deliver \/ RejectLate \/ AcceptA \/ Disk
        \/ (\E p \in Peers : Propose(p) \/ SendOpen(p))
        \/ (\E k \in Keys : Open(k) \/ Prompt(k))
        \/ (\E h \in Peers \cup {0} : Link(h))
        \/ (\E q \in {"owner_allowed", "owner_denied", "withdrawn", "self_decided", "replaced"} : QuestionResult(q))
Spec == Init /\ [][Next]_vars
DurableBeforeOpen == \A k \in opened : saved[k[1]] = k[2]
OneWorkerPerGeneration == \A g \in Epochs : Cardinality({k \in opened : k[1] = g}) <= 1
AddressFence == received \in {NoMail, <<0,1>>, envelope}
Prerequisites == opened = {} \/ Ready
=============================================================================
