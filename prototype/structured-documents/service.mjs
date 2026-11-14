import {openDocumentStore} from './core.mjs';

// Explicit wiring only: never starts a timer, opens a DB, reads credentials, or
// touches the live recording queue. The existing backend owns scheduling/cutover.
export function createDocumentService({db,generate,resolveBinding,patchOriginalCard}) {
  const store=openDocumentStore(db);
  let running=false;
  return {
    enqueue:recording=>store.enqueue(recording),
    async pump() {
      if(running)return {busy:true};running=true;
      try {
        while(await store.generateNext(generate)) {}
        const ids=db.prepare("SELECT recordingId FROM structured_document_jobs WHERE state='ready'").all();
        const outcomes=[];
        for(const {recordingId} of ids) {
          // Only a verified existing recording-card binding; never create a card here.
          const binding=await resolveBinding(null,recordingId);
          if(!binding){outcomes.push({recordingId,state:'awaiting_original_card'});continue;}
          try {const r=await store.deliver(recordingId,binding,patchOriginalCard);outcomes.push({recordingId,state:r.delivery.state});}
          catch {outcomes.push({recordingId,state:'pending'});}
        }
        return outcomes;
      }finally{running=false;}
    },
    async receipt(device,id) {
      const binding=await resolveBinding(device,id);
      return store.receipt(id,binding);
    },
    readArtifact:(_device,id,revision,file)=>store.readArtifact(id,revision,file),
  };
}
